import fs from 'node:fs';
import {getTemplate} from '../../core/prompt-templates.mjs';
import {profileHeadings} from './heading-profile.mjs';
import {restoreStructuralHeadings} from './structural-restore.mjs';
import {repairCompoundHeadings} from './heading-repair.mjs';
import {askJson,checkedBatch} from './model-json.mjs';
import {matchTrustedHeadings} from './template-matcher.mjs';

const template=(id,file)=>getTemplate(id)||fs.readFileSync(new URL('../../prompts/'+file,import.meta.url),'utf8');
const sample=(rows,count=12)=>Array.from(new Set(Array.from({length:Math.min(count,rows.length)},(_,i)=>Math.round(i*(rows.length-1)/Math.max(1,Math.min(count,rows.length)-1))))).map(i=>rows[i]);
function pack(rows,prefix,maxRows=220){const batches=[];let current=[],size=prefix.length+2;if(size>22000)throw Error('结构 Prompt 过长');for(const row of rows){const n=JSON.stringify(row).length+1;if(n+prefix.length+2>24000)throw Error('单个结构候选超过模型输入限制');if(current.length&&(size+n>23000||current.length>=maxRows)){batches.push(current);current=[];size=prefix.length+2;}current.push(row);size+=n;}if(current.length)batches.push(current);return batches;}

export async function buildStructuredIndex(text,fallbackName,model,chat,{bookName:explicitName='',profile=profileHeadings(text)}={}){
 const fileTitle=(fallbackName.match(/《([^》]+)》/)?.[1]||fallbackName).replace(/\s+\d+\s*[-～至]\s*\d+卷.*$/,'').replace(/\s*[（(][^）)]*[）)](?:\s.*)?$/,'').replace(/[-_\s]+(?:清洗后|已清洗|校对|整理|副本)(?:[-_\s]*\d{6,8})?$/,'').trim();
 const repairs=await repairCompoundHeadings(text,profile,model,chat);
 if(!profile.families.length)return null;
 const families=profile.families.map(f=>({id:f.id,count:f.count,samples:f.samples.map(r=>({id:r.id,title:r.raw,number:r.number,gap:r.gap,before:r.before,after:r.after}))}));
 const strategyPrompt=template('cleanStructureStrategy','clean-structure-strategy.prompt')+'\n【文件名书名参考】\n'+fileTitle+'\n【原文开头】\n'+text.slice(0,1600)+'\n【家族证据】\n'+JSON.stringify(families);
 if(strategyPrompt.length>24000)throw Error('结构策略证据超过模型输入限制');
 let decision=await askJson(chat,{prompt:strategyPrompt,model,maxTokens:1200,temperature:0,source:'clean-structure-strategy'});
 if(!Array.isArray(decision.families))throw Error('结构策略模型没有返回 families 数组');
 const allowed=new Set(profile.families.map(f=>f.id));
 if(decision.families.some(id=>!allowed.has(id)))decision=await askJson(chat,{prompt:strategyPrompt+'\n上次响应包含未提供的标题家族。唯一合法的 families 值来自：'+JSON.stringify([...allowed])+'。不要从标题中的副编号发明新家族；重新选择并返回 JSON。',model,maxTokens:1200,temperature:0,source:'clean-structure-strategy'});
 if(!Array.isArray(decision.families))throw Error('结构策略缺少 families 数组');for(const id of decision.families)if(!allowed.has(id))throw Error('模型返回无效标题家族：'+id);
 if(!decision.families.length)return null;
 const sourceNames=new Set(profile.rows.filter(r=>r.standardized&&!r.duplicateOf&&!r.structuralRole).map(r=>r.sourceBookName));const exportedName=sourceNames.size===1?[...sourceNames][0]:'';
 let bookName=explicitName||exportedName||String(decision.bookName||'').trim();
 if(!explicitName&&!exportedName&&(!bookName||!text.includes(bookName)||fileTitle.replace(/[\s，,:：]/g,'')!==bookName.replace(/[\s，,:：]/g,'')))bookName=fileTitle;
 const approved=new Set(decision.families);const rows=profile.rows.filter(r=>!r.duplicateOf&&!r.structuralRole&&(approved.has(r.family)||r.repaired));const selected=new Map(rows.map(r=>[r.id,{...r,kind:'chapter',source:'model-structured'}]));const rejected=[];const ignoredSpecial=[];let reviewed=0;
 const rules=template('cleanStructureReview','clean-structure-review.prompt');
 const references=rows.filter(r=>!r.embedded&&r.raw.length<=45&&r.gap>=300&&!/[。]/.test(r.raw));
 const prefix=rules+'\n【本书稳定标题格式参考】\n'+JSON.stringify(sample(references.length?references:rows,8).map(r=>r.raw))+'\n【本批标题】\n';
 const {trusted,proofs}=matchTrustedHeadings(rows);
 const compact=rows.filter(r=>!trusted.has(r.id)).map((r,i)=>{const item={id:r.id,n:r.number,gap:r.gap,title:r.raw};if(r.embedded||r.raw.length>45||r.gap<100||(i&&r.number<rows[i-1].number&&!r.volumeLabel)){item.before=r.before;item.after=r.after;}return item;});
 for(const originalBatch of pack(compact,prefix)){
  for(const {batch,data} of await checkedBatch(chat,{prefix,model,maxTokens:3500,temperature:0,source:'clean-structure-review'},originalBatch,'review')){
   if(!Array.isArray(data.reject))throw Error('结构复核模型没有返回 reject 数组');
   const ids=new Set(batch.map(r=>r.id));reviewed+=batch.length;
   for(const item of data.reject){const id=typeof item==='string'?item:item.id;if(!ids.has(id))throw Error('结构复核返回无效定位标识：'+id);const r=selected.get(id);if(r){selected.delete(id);rejected.push({id,index:r.index,line:r.raw,reason:item.reason||''});}}
   for(const item of data.special||[]){if(!ids.has(item.id)||!['preface','afterword','appendix','volume'].includes(item.kind))throw Error('附属篇目返回无效定位标识或分类');if(item.kind==='volume'){ignoredSpecial.push({id:item.id,kind:item.kind,reason:'numbered-source-chapter-cannot-be-volume'});continue;}if(selected.has(item.id))selected.get(item.id).kind=item.kind;}
  }
 }
 const priorReasons=new Map(rejected.map(r=>[r.id,r.reason]));
 const auditRows=rows.filter(r=>priorReasons.has(r.id));
 if(auditRows.length){
   const referenceOnly=references.filter(r=>!priorReasons.has(r.id));
   const p=template('cleanStructureConfirm','clean-structure-confirm.prompt')+'\n【本书主标题格式】\n'+JSON.stringify(sample(referenceOnly,10).map(r=>r.raw))+'\n【待确认剔除条目】\n';
   const checks=auditRows.map(row=>{const i=rows.findIndex(r=>r.id===row.id);return {id:row.id,title:row.raw,previous:rows[i-1]?.raw,next:rows[i+1]?.raw,before:row.before,after:row.after,priorReason:priorReasons.get(row.id)||'结构偏离或正文粘连，需要独立判断'};});
   const finalReject=new Set();
   for(const originalBatch of pack(checks,p,45)){
    for(const {batch,data} of await checkedBatch(chat,{prefix:p,model,maxTokens:2500,temperature:0,source:'clean-structure-confirm'},originalBatch,'confirm')){
     const ids=new Set(batch.map(r=>r.id)),seen=new Set();if(!Array.isArray(data.decisions))throw Error('剔除确认缺少 decisions');
     for(const d of data.decisions){if(!ids.has(d.id)||seen.has(d.id)||typeof d.keep!=='boolean')throw Error('剔除确认定位标识或结果无效');seen.add(d.id);if(!d.keep){finalReject.add(d.id);selected.delete(d.id);}else{const row=rows.find(r=>r.id===d.id);if(!selected.has(row.id))selected.set(row.id,{...row,kind:'chapter',source:'model-structured'});}}
     if(seen.size!==ids.size)throw Error('剔除确认遗漏候选，不能生成不完整目录');
    }
   }
   rejected.splice(0,rejected.length,...auditRows.filter(r=>finalReject.has(r.id)).map(r=>({id:r.id,index:r.index,line:r.raw,reason:priorReasons.get(r.id)||'模型判定为正文或非章节内容'})));
 }
 const restoredStructural=restoreStructuralHeadings(rows,selected);
 const restoredIds=new Set(restoredStructural.map(r=>r.id));for(let i=rejected.length-1;i>=0;i--)if(restoredIds.has(rejected[i].id))rejected.splice(i,1);
 // 明确的前言后记单独处理，避免人物姓氏“跋”之类叙事误入候选。
 const occupied=new Set(profile.rows.map(r=>r.index));const lines=text.split('\n');let offset=0;const extras=[];
 for(let i=0;i<lines.length;i++){const raw=lines[i].trim();if(!occupied.has(i)&&raw.length<=65&&/^(?:(?:《[^》]+》|[^。！？]{0,12})\s*)?(?:前言|序言|序章|楔子|引子|后记|後記|附录|附錄|跋(?:$|[：:·\s])|第[\d一二三四五六七八九十百千万廿卅]+[卷部集])/.test(raw))extras.push({id:'S'+i,index:i,line:raw,start:offset+lines[i].indexOf(raw),end:offset+lines[i].length,before:lines.slice(Math.max(0,i-2),i).join('\n').slice(-100),after:lines.slice(i+1,i+4).join('\n').slice(0,100)});offset+=lines[i].length+1;}
 if(extras.length){const p=template('cleanSupplementary','clean-supplementary.prompt')+'\n【附属篇目候选及上下文】\n';for(const batch of pack(extras,p,60)){const data=await askJson(chat,{prompt:p+JSON.stringify(batch),model,maxTokens:2000,temperature:0,source:'clean-structured-supplementary'});for(const item of data.rows||[]){const row=batch.find(r=>r.index===Number(item.index));if(row&&['preface','afterword','appendix','volume'].includes(item.kind))selected.set(row.id,{...row,raw:row.line,title:row.line,number:null,kind:item.kind,source:'model-structured'});}}}
 const sections=[...selected.values()].sort((a,b)=>a.start-b.start);const chapters=sections.filter(s=>s.kind==='chapter');if(!chapters.length)throw Error('模型未确认任何正文章节');
 for(const section of sections){if(section.kind==='chapter')section.heading=`《${bookName}》（第${section.number}章${section.volumeLabel?'·'+section.volumeLabel:''}）${section.title?' '+section.title:''}`;else{section.title=section.raw;section.heading=section.raw;}}
 const duplicateIds=new Set(profile.duplicates.filter(d=>selected.has(d.kept)).map(d=>d.id));
 const changes=[...sections.map(s=>({...s,replacement:s.heading})),...profile.rows.filter(r=>duplicateIds.has(r.id)).map(r=>({...r,replacement:''}))].sort((a,b)=>a.start-b.start);
 let body='',cursor=0;for(const item of changes){if(item.start<cursor)throw Error('章节定位范围重叠');body+=text.slice(cursor,item.start);if(item.replacement){if(body&&!body.endsWith('\n'))body+='\n';body+=item.replacement;if(text[item.end]&&text[item.end]!=='\n')body+='\n';}cursor=item.end;}body+=text.slice(cursor);
 const toc=sections.map(s=>s.heading);return {bookName,chapterCount:chapters.length,chapters,sections,warnings:[],cleanDoc:{书名:bookName,目录:toc,正文:body},validation:{strategy:'model-approved-template',families:decision.families,reason:decision.reason||'',candidates:profile.rows.length,reviewed,templateMatched:trusted.size,templateProofs:proofs,modelChapters:chapters.length,ignoredSpecial,rejected,repairs,restoredStructural,structuralExclusions:profile.rows.filter(r=>r.structuralRole).map(r=>({id:r.id,index:r.index,line:r.raw,reason:r.structuralRole})),duplicateHeadings:profile.duplicates.filter(d=>duplicateIds.has(d.id)),supplementarySections:sections.length-chapters.length},structured:`书名《${bookName}》\n\n清洗后目录：\n${toc.join('\n')}\n\n清洗正文：\n\n${body}`};
}
