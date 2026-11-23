import fs from 'node:fs';
import {getTemplate} from '../../core/prompt-templates.mjs';
import {parseSourceHeading,refreshDuplicateHeadings,headingMarkerOffset} from './heading-profile.mjs';
import {askJson} from './model-json.mjs';

export async function repairCompoundHeadings(text,profile,model,chat){
 const hasSubsections=profile.families.some(f=>f.id==='number-punctuation');
 let candidates=profile.rows.filter(r=>!r.structuralRole&&(r.needsBoundaryRepair||(hasSubsections&&r.unit&&/\d+[.．、][^\d]/.test(r.title)&&/[。]/.test(r.title))));
 if(!candidates.length)return [];
 const rules=getTemplate('cleanStructureRepair')||fs.readFileSync(new URL('../../prompts/clean-structure-repair.prompt',import.meta.url),'utf8');
 const repairs=[];
 // 连续重复的短标题可精确确定下一行粘连标题的边界，避免模型将标题截短。
 for(const original of candidates){const index=profile.rows.indexOf(original),previous=profile.rows[index-1];
  if(!previous||previous.needsBoundaryRepair||previous.number!==original.number||previous.unit!==original.unit||text.slice(previous.end,original.start).trim())continue;
  const needle=previous.raw.replace(/\s/g,'');const positions=[];let compact='';for(let i=0;i<original.raw.length;i++)if(!/\s/.test(original.raw[i])){compact+=original.raw[i];positions.push(i);}
  if(!needle||!compact.startsWith(needle))continue;
  const line=original.raw;const heading=line.slice(0,positions[needle.length-1]+1);const parsed=parseSourceHeading(heading,{allowEmbedded:true});if(!parsed)continue;
  Object.assign(original,parsed,{raw:heading,end:original.start+heading.length,repaired:true,repairSource:'adjacent-source-title',needsBoundaryRepair:false});
  repairs.push({id:original.id,line,headings:[heading],source:'adjacent-source-title',locations:[{id:original.id,start:original.start,end:original.end,raw:heading}]});
 }
 candidates=candidates.filter(r=>!r.repaired);
 for(let offset=0;offset<candidates.length;offset+=8){
  const batch=candidates.slice(offset,offset+8);const input=batch.map(r=>{const i=profile.rows.indexOf(r);return{id:r.id,line:r.raw.slice(0,1800),before:r.before,after:r.after,nearby:[profile.rows[i-1]?.raw.slice(0,120),profile.rows[i+1]?.raw.slice(0,120)]};});
  const prompt=rules+'\n【待修复边界】\n'+JSON.stringify(input);if(prompt.length>24000)throw Error('粘连标题修复输入超限');
  let data;let feedback='';
  for(let attempt=0;attempt<2;attempt++){
   data=await askJson(chat,{prompt:prompt+feedback,model,maxTokens:2500,temperature:0,source:'clean-structure-repair'});
   try{
    if(!Array.isArray(data.rows))throw Error('缺少 rows');const seen=new Set();
    for(const item of data.rows){const original=batch.find(r=>r.id===item.id);if(!original||seen.has(item.id))throw Error('无效或重复的源标识');seen.add(item.id);if(!Array.isArray(item.headings))throw Error('缺少 headings');let consumed=0;
     for(let h=0;h<item.headings.length;h++){let heading=item.headings[h];let position=original.raw.indexOf(heading,consumed);
      // 模型偶尔在章号周围补空格。只在去空白后唯一匹配时恢复实际原文，绝不改字或标点。
      if(position<0&&typeof heading==='string'){
       const indices=[];let compact='';for(let i=consumed;i<original.raw.length;i++)if(!/\s/.test(original.raw[i])){compact+=original.raw[i];indices.push(i);}
       const needle=heading.replace(/\s/g,'');const at=compact.indexOf(needle);
       if(needle&&at>=0&&compact.indexOf(needle,at+1)<0){position=indices[at];heading=original.raw.slice(position,indices[at+needle.length-1]+1);(item.sourceAlignedHeadings??=[]).push({model:item.headings[h],source:heading});item.headings[h]=heading;}
      }
      if(!heading||position<0||!parseSourceHeading(heading,{allowEmbedded:true}))throw Error('标题必须逐字复制该行原文，不能修改数字、标点或空格：'+JSON.stringify(heading));consumed=position+heading.length;}
     if(!item.headings.length&&item.kind!=='body')throw Error('空标题必须明确 kind=body');
    }
    if(seen.size!==batch.length)throw Error('遗漏待修复条目');break;
   }catch(error){if(attempt===1)throw error;feedback='\n上次响应校验失败：'+error.message+'。请重新检查全部条目。headings 只能是对应 line 中连续、逐字一致的子串；正文条目返回 kind="body",headings=[]。';}
  }
  for(const item of data.rows||[]){const original=batch.find(r=>r.id===item.id);if(!original)throw Error('粘连修复返回无效源标识');if(!Array.isArray(item.headings))throw Error('粘连修复缺少 headings');if(!item.headings.length){if(item.kind==='body'){original.structuralRole='model-repair-narrative';repairs.push({id:original.id,line:original.raw,kind:'body',headings:[]});}continue;}
   let consumed=0;const replacements=[];
   for(const heading of item.headings){const pos=original.raw.indexOf(heading,consumed);let parsed=parseSourceHeading(heading,{allowEmbedded:true});if(pos<0||!parsed)throw Error('粘连修复标题必须逐字来自原文并具有合法编号');
    let trimOffset=parsed.offset;const verifiedPrefix=parsed.family==='volume-chapter'||!parsed.prefix||parsed.prefix==='正文'||/^(?:卷|第[\d一二三四五六七八九十百千万]+[卷部])/.test(parsed.prefix)||text.split('\n').some(line=>line.trim()===parsed.prefix)||profile.rows.filter(r=>r.prefix===parsed.prefix).length>=2;
    if(!verifiedPrefix)trimOffset=headingMarkerOffset(heading);
    const cleanHeading=heading.slice(trimOffset);parsed=parseSourceHeading(cleanHeading,{allowEmbedded:true});
    const start=original.start+pos+trimOffset;const column=Number(original.id.split('C')[1])+pos+trimOffset;
    replacements.push({...original,...parsed,id:`L${original.index}C${column}`,raw:cleanHeading,start,end:original.start+pos+heading.length,embedded:original.embedded||pos>0||trimOffset>0,repaired:true,needsBoundaryRepair:false,duplicateOf:null});consumed=pos+heading.length;
   }
   if(replacements.length>1||original.needsBoundaryRepair){const index=profile.rows.indexOf(original);profile.rows.splice(index,1,...replacements);repairs.push({id:original.id,line:original.raw,headings:replacements.map(r=>r.raw),locations:replacements.map(r=>({id:r.id,start:r.start,end:r.end,raw:r.raw})),modelHeadings:item.headings,sourceAlignedHeadings:item.sourceAlignedHeadings||[]});}
  }
 }
 const unresolved=profile.rows.filter(r=>r.needsBoundaryRepair&&!r.structuralRole);if(unresolved.length)throw Error('未确认粘连标题边界：原文第 '+(unresolved[0].index+1)+' 行');
 if(repairs.length){
  profile.duplicates=refreshDuplicateHeadings(text,profile.rows);
  for(let i=0;i<profile.rows.length;i++){const r=profile.rows[i];r.gap=(profile.rows[i+1]?.start??text.length)-r.end;}
  const families=new Map();for(const r of profile.rows.filter(r=>!r.duplicateOf&&!r.structuralRole)){if(!families.has(r.family))families.set(r.family,[]);families.get(r.family).push(r);}
  profile.families=[...families].map(([id,rows])=>({id,count:rows.length,samples:[...new Set([0,1,Math.floor(rows.length/2),rows.length-2,rows.length-1])].filter(i=>i>=0&&i<rows.length).map(i=>rows[i])}));
 }
 return repairs;
}
