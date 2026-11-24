import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { listModels } from '../lib/gateway.mjs';

export { listModels };
export const fallbackModel = 'qwen3.5:4b';
const isLocal = config => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.gateway).hostname);

export function inheritedCleanModel(config) {
  const scenes = config.stages.scenes.model;
  return isLocal(config) && !config.stages.structure.model && scenes === config.stages.characters.model ? scenes : '';
}

export async function resolveModel(config, stage, signal) {
  const selected = config.stages[stage]?.model;
  if (selected) return selected;
  const inherited = stage === 'structure' ? inheritedCleanModel(config) : '';
  if (inherited) return inherited;
  if (isLocal(config) && (await listModels(config, signal)).includes(fallbackModel)) return fallbackModel;
  throw Error('请先在右上角「配置 LocalAI 模型」中保存该阶段的模型');
}

export function createModelConsole({ config, model, signal, logFile, safeLog }) {
  const state = { enabled: true, last: { model } };
  return {
    state,
    async chat({ prompt, system, source, runId, temperature = 0.1, maxTokens = config.maxTokens, maxAttempts = 3,
      json = true, cachePrompt = false, reasoningEffort, model: requestedModel }) {
      const selected = requestedModel || model;
      const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
        : [{ role: 'user', content: prompt }];
      const payload = {
        model: selected, messages, temperature, cache_prompt: cachePrompt, stream: false,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(config.disableReasoning !== false ? { reasoning_effort: reasoningEffort || 'none' } : {}),
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      };
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (config.apiKey) headers.Authorization = 'Bearer ' + config.apiKey;
      let failure;
      const tries = Math.min(Math.max(1, Number(maxAttempts) || 1), 3);
      for (let i = 0; i < tries; i += 1) {
        signal?.throwIfAborted();
        const started = Date.now();
        try {
          const timeout = AbortSignal.timeout(config.timeoutMs);
          const response = await fetch(config.gateway + '/chat/completions', {
            method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error',
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          });
          if (!response.ok) {
            const shouldRetry = response.headers.get('x-should-retry')?.trim().toLowerCase() !== 'false';
            const busy = response.status === 429 && !shouldRetry && isLocal(config);
            await response.body?.cancel();
            const error = Error(busy ? 'LocalAI 正在处理其他请求（HTTP 429）。请等待 LocalAI 空闲后继续。'
              : '模型网关返回 HTTP ' + response.status);
            error.http = response.status;
            error.shouldRetry = shouldRetry;
            throw error;
          }
          const result = await response.json();
          const choice = result.choices?.[0];
          const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
          const usage = result.usage;
          const finish = choice?.finish_reason === 'length' ? 'length' : 'stop';
          const ok = finish !== 'length' && Boolean(content.trim());
          const error = finish === 'length' ? '模型输出达到 token 上限' : '模型没有返回正文';
          log({ source, runId, model: selected, ok, finish, usage, ms: Date.now() - started });
          return ok ? { ok, content, model: selected, usage, finish }
            : { ok, content, error, model: selected, usage, finish, truncated: finish === 'length' };
        } catch (error) {
          signal?.throwIfAborted();
          failure = error.http ? error.message : error.name === 'TimeoutError'
            ? '模型请求超时（' + config.timeoutMs / 1000 + ' 秒）' + (isLocal(config) ? '。请等待 LocalAI 空闲后继续。' : '')
            : '无法读取模型网关响应';
          log({ source, runId, model: selected, ok: false, error: failure, ms: Date.now() - started });
          if (!error.shouldRetry || ![429, 503].includes(error.http)) break;
          if (i + 1 < tries) await sleep(800, undefined, { signal });
        }
      }
      throw Error(failure || '模型请求失败');
    },
  };

  function log(row) {
    const usage = row.usage;
    const entry = {
      at: new Date().toISOString(), ...row,
      usage: usage ? { prompt_tokens: Number(usage.prompt_tokens) || 0, completion_tokens: Number(usage.completion_tokens) || 0 } : undefined,
    };
    try {
      if (safeLog) safeLog(entry);
      else if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch { /* Failure to record diagnostics does not alter the model result. */ }
  }
}

