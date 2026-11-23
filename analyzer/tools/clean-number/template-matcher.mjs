// 模型选择的家族内，按原文格式和编号分布匹配高置信标题；模糊项仍需逐条模型审核。
export function matchTrustedHeadings(rows){
 const counts=new Map(),prefixes=new Map();for(const r of rows){const key=(r.unit||r.family)+'|'+r.number;counts.set(key,(counts.get(key)||0)+1);prefixes.set(r.prefix,(prefixes.get(r.prefix)||0)+1);}
 const trusted=new Set(),proofs=[];const metadata=/(?:请假|公告|求票|月票|推荐票|更新|新书|完本感言|感谢打赏|求订阅|作者的话|单章)/;
 const parents=rows.filter(r=>!r.embedded&&['章','回','折'].includes(r.unit)&&r.raw.length<=85&&!/[。]/.test(r.title)&&!r.structuralRole);
 const parentIds=new Set(parents.map(r=>r.id));const scopes=new Map(),scopeFor=new Map();let parent=null;
 for(const row of rows){if(parentIds.has(row.id))parent=row;if(!row.unit&&parent){const key=row.family+'|'+parent.id;scopeFor.set(row.id,key);if(!scopes.has(key))scopes.set(key,{parent,rows:[]});scopes.get(key).rows.push(row);}}
 const validScopes=new Set();for(const [key,scope]of scopes)if(scope.rows.length>=2&&scope.rows[0].number===1&&scope.rows[1].number===2&&scope.rows[0].start-scope.parent.end<100)validScopes.add(key);
 for(let i=0;i<rows.length;i++){
  const r=rows[i];if(r.structuralRole||r.needsBoundaryRepair||metadata.test(r.title))continue;
  let prior=null,next=null;for(let n=i-1;n>=0;n--)if((r.unit&&rows[n].unit===r.unit)||(!r.unit&&rows[n].family===r.family)){prior=rows[n];break;}for(let n=i+1;n<rows.length;n++)if((r.unit&&rows[n].unit===r.unit)||(!r.unit&&rows[n].family===r.family)){next=rows[n];break;}
  const unique=counts.get((r.unit||r.family)+'|'+r.number)===1;
  const continuity=unique&&((prior?.number===r.number-1&&next?.number===r.number+1)||(r.number===1&&next?.number===2)||(prior?.number===r.number-1&&!next));
  const stablePrefix=r.family==='volume-chapter'||!r.prefix||r.prefix==='正文'||/^(?:卷|第[\d一二三四五六七八九十百千万]+[卷部])/.test(r.prefix)||(prefixes.get(r.prefix)||0)>=3;
  const child=rows[i+1];const parent=child&&child.start-r.end<100&&(child.number===1||child.unit!==r.unit);
  const formal=!r.embedded&&['章','回','折'].includes(r.unit)&&r.raw.length<=85&&!/[。]/.test(r.title)&&stablePrefix&&(r.gap>=200||parent||!child);
  const embedded=r.embedded&&['章','回','折'].includes(r.unit)&&r.title.length<=60&&!/[。！？!?，,：“”]/.test(r.title)&&continuity&&r.gap>=200;
  let scopedContinuity=false;const scopeKey=scopeFor.get(r.id);if(validScopes.has(scopeKey)){const group=scopes.get(scopeKey).rows;const position=group.indexOf(r);const a=group[position-1],b=group[position+1];scopedContinuity=group.filter(x=>x.number===r.number).length===1&&((a?.number===r.number-1&&b?.number===r.number+1)||(r.number===1&&b?.number===2)||(a?.number===r.number-1&&!b));}
  const numbered=!r.unit&&r.raw.length<=70&&(parents.length?scopedContinuity:continuity)&&r.gap>=200;
  if(r.repaired||formal||embedded||numbered){trusted.add(r.id);proofs.push({id:r.id,index:r.index,number:r.number,kind:r.repaired?(r.repairSource||'model-repaired-boundary'):formal?'explicit-source-template':'unique-continuous-source-sequence'});}
 }
 return {trusted,proofs};
}
