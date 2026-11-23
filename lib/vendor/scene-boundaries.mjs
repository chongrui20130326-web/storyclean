// 请求窗口不构成语义边界；最终场景另行执行完整句子5000字上限。
export function limitSceneCuts(sentences, cuts, maxChars = 5000) {
  if (!Number.isFinite(maxChars) || maxChars < 1) throw Error('场景字数上限无效');
  for (const row of sentences) if (String(row.text ?? '').length > maxChars) {
    throw Error('单句超过' + maxChars + '字，请先检查句子编号：S' + row.n);
  }
  const scenes = toSceneRanges({ id: '' }, sentences, cuts);
  const result = new Set(cuts);
  const positions = new Map(sentences.map((row, i) => [row.n, i]));
  for (const scene of scenes) {
    if (scene.chars <= maxChars) continue;
    const from = positions.get(Number(scene.from.slice(1))), to = positions.get(Number(scene.to.slice(1))) + 1;
    const parts = [];
    let start = from, chars = 0;
    for (let i = from; i < to; i++) {
      const length = String(sentences[i].text ?? '').length;
      if (i > start && chars + length > maxChars) { parts.push([start, i, chars]); start = i; chars = 0; }
      chars += length;
    }
    parts.push([start, to, chars]);
    // 在不移动模型语义边界的前提下，均衡同一长场最后两段，避免人为短尾。
    if (parts.length > 1) {
      const left = parts.at(-2), right = parts.at(-1), total = left[2] + right[2];
      let prefix = 0, best = left[1], bestDistance = Math.abs(left[2] - total / 2);
      for (let i = left[0]; i < right[1] - 1; i++) {
        prefix += String(sentences[i].text ?? '').length;
        const distance = Math.abs(prefix - total / 2);
        if (prefix <= maxChars && total - prefix <= maxChars && distance < bestDistance) { best = i + 1; bestDistance = distance; }
      }
      left[1] = best; right[0] = best;
    }
    for (const part of parts.slice(0, -1)) result.add(sentences[part[1] - 1].n);
  }
  return [...result].sort((a, b) => a - b);
}

export function validateSceneCuts(value,allowed){
  if(value&&Object.hasOwn(value,'checks')){
    if(!Array.isArray(value.checks))throw Error('边界 checks 必须是数组');
    const candidates=[];
    for(const row of value.checks){
      if(!row||typeof row.newScene!=='boolean')throw Error('边界 newScene 必须是布尔值');
      if(!Number.isInteger(row.cut)||!Number.isInteger(row.next))throw Error('边界 cut 和 next 必须为整数句号');
      if(row.next!==row.cut+1)throw Error('cut='+row.cut+' 时 next 必须为 '+(row.cut+1)+'，不能填 '+row.next+'；即使下一编号是章节标题也不能跳过，标题归入随后场景');
      if(row.newScene?!['时间','地点','独立行动线','同地新事件'].includes(row.change):row.change!=='连续')throw Error('边界类型与新场景判定矛盾');
      candidates.push(row.cut);
    }
    validateSceneCuts({cuts:candidates},allowed);
    return value.checks.filter(row=>row.newScene).map(row=>row.cut);
  }
  if(!value||!Array.isArray(value.cuts))throw Error('切点 cuts 必须是数组');
  let previous=-Infinity;
  for(const cut of value.cuts){
    if(!Number.isInteger(cut)||!allowed.has(cut))throw Error('切点不是允许的原文句号');
    if(cut<=previous)throw Error('切点必须严格递增且不能重复');previous=cut;
  }
  return value.cuts;
}

export async function modelSceneCuts(sentences,{chat,template='',maxChars=5000,onBatch=()=>{},onRetry=()=>{},startAt=0,initialCuts=[]}={}){
  if(!Number.isFinite(maxChars)||maxChars<1)throw Error('场景输入字数上限无效');
  if(!Number.isInteger(startAt)||startAt<0||startAt>sentences.length)throw Error('批次续跑位置无效');
  const cuts=new Set(validateSceneCuts({cuts:initialCuts},new Set(sentences.slice(0,startAt).map(row=>row.n))));
  let start=startAt,batchSentenceLimit=Infinity,reductions=0;
  while(start<sentences.length){
    const batch=[];let chars=0;
    for(let i=start;i<sentences.length;i++){
      if(batch.length>=batchSentenceLimit)break;
      const row=sentences[i],length=String(row.text||'').length;
      if(length>Math.max(maxChars,12000))throw Error('单句过长，请先检查句子编号：S'+row.n);
      if(batch.length&&chars+length>maxChars)break;
      batch.push(row);chars+=length;
    }
    const previous=sentences[start-1];
    // The next batch owns the seam once the next sentence is included in full.
    const allowed=new Set(batch.slice(0,-1).map(row=>row.n));if(previous)allowed.add(previous.n);
    const context=sentences.slice(Math.max(0,start-2),start).map(row=>`[前文参考 S${row.n}] ${String(row.text||'').slice(-1000)}`).join('\n');
    const next=sentences.slice(start+batch.length,start+batch.length+2).map(row=>`[后文参考 S${row.n}，禁止作为切点] ${String(row.text||'').slice(0,1000)}`).join('\n');
    const starts=[...allowed].map(cut=>cut+1).sort((a,b)=>a-b);
    const allowedDescription=starts.length
      ? `【可选的场景起始编号】${starts.join(', ')}。`
      : '【可选的场景起始编号】无。输出 {"starts":[]}。';
    const output='只输出 JSON 对象 {"starts":[]}，把明确开启新场景的句子编号填入数组。编号必须来自可选列表，使用升序整数；没有转场时数组留空。';
    const prompt=[template,'【任务】识别新场景的第一句，选择行首编号。明显跳到另一时间、地点或独立行动线时，新场景从写出这次跳转的第一句开始。',
      '同一现场的换人说话、进出、心理描写和话题切换保持连续。问答、动作和紧随的反应保留在同一场。章节或批次结尾不自动切分。全文最后一句由程序自动收尾。',
      previous?'如果本批第一句已经跳到新场景，可以选它的编号。':'第 1 句是原稿开头，不能选。',
      '前文和后文只作参考；只选择本批待判句子里的编号。',
      allowedDescription,output,
      '【上批末尾参考】',context||'（无）','【本批待判句子：完整原文】',batch.map(row=>`${row.n}. ${row.text}`).join('\n'),
      '【后续参考】',next||'（全文末尾）',allowedDescription,output].join('\n');
    let decisions,feedback='',lastValidationError;
    for(let attempt=0;attempt<2;attempt++){
      const response=await chat(prompt+feedback);
      const raw=String(response?.content??response?.text??'');
      // 网络异常从 chat 抛出。截断即便没有可见正文，也需要有界重试。
      try{
        if(response?.ok===false)throw Error(response.error||'场景模型输出无效');
        const value=JSON.parse(raw.slice(raw.indexOf('{'),raw.lastIndexOf('}')+1));
        if(value&&Object.hasOwn(value,'starts')){
          if(!Array.isArray(value.starts)||value.starts.some(n=>!Number.isInteger(n)))throw Error('场景起始编号必须是整数数组');
          decisions=validateSceneCuts({cuts:value.starts.map(n=>n-1)},allowed);
        }else decisions=validateSceneCuts(value,allowed);
        break;
      }
      catch(error){
        lastValidationError=error instanceof SyntaxError?Error('场景模型输出不是完整 JSON'):error;
        onRetry(lastValidationError.message);
        feedback='\n上次输出校验失败：'+lastValidationError.message+'。'+allowedDescription+output;
      }
    }
    if(decisions===undefined){
      if(batch.length>1&&reductions<3){batchSentenceLimit=Math.ceil(batch.length/2);reductions++;continue;}
      throw Error('场景切点校验失败：'+lastValidationError.message);
    }
    for(const cut of decisions)cuts.add(cut);
    start+=batch.length;batchSentenceLimit=Infinity;reductions=0;onBatch({done:start,total:sentences.length,cuts:[...cuts].sort((a,b)=>a-b)});
  }
  return [...cuts].sort((a,b)=>a-b);
}

export function toSceneRanges(chapter,sentences,cuts,source='model'){
  if(!sentences.length)return [];
  const positions=new Map(sentences.map((row,index)=>[row.n,index]));
  if(positions.size!==sentences.length)throw Error('原文句号重复');
  for(let i=1;i<sentences.length;i++)if(sentences[i].n!==sentences[i-1].n+1)throw Error('原文句号不连续，请先检查内容编号');
  validateSceneCuts({cuts},new Set(positions.keys()));
  const ranges=[];let start=0;
  for(const cut of cuts){const end=positions.get(cut);if(end<start)continue;ranges.push([start,end]);start=end+1;}
  if(start<sentences.length)ranges.push([start,sentences.length-1]);
  return ranges.map(([from,to],index)=>{
    const rows=sentences.slice(from,to+1);
    const sources=new Map(rows.map(row=>[row.chapterId??chapter.id,row.chapterTitle??chapter.title??'']));
    const chapterIds=[...sources.keys()],chapterTitles=[...sources.values()];
    return {chapterId:chapterIds[0],endChapterId:chapterIds.at(-1),chapterIds,chapterTitles,
      chapterTitle:chapterTitles.length===1?chapterTitles[0]:chapterTitles[0]+' ～ '+chapterTitles.at(-1),
      from:'S'+sentences[from].n,to:'S'+sentences[to].n,sentences:to-from+1,
      chars:rows.reduce((sum,row)=>sum+String(row.text??'').length,0),source,order:index+1};
  });
}
