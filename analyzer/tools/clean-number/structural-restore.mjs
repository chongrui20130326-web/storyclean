// 模型批准标题家族后，来源明确的模板和层级边界不能仅因语义复核的不确定措辞丢失。
export function restoreStructuralHeadings(rows, selected) {
 const prefixCounts=new Map();for(const row of rows)prefixCounts.set(row.prefix,(prefixCounts.get(row.prefix)||0)+1);
 const restored=[];
 for(let i=0;i<rows.length;i++){
  const row=rows[i];if(selected.has(row.id)||row.structuralRole)continue;
  if(row.repaired){selected.set(row.id,{...row,kind:'chapter',source:row.repairSource||'model-repaired-source-boundary'});restored.push({id:row.id,index:row.index,line:row.raw,reason:row.repairSource||'model-repaired-source-boundary'});continue;}
  const stablePrefix=row.family==='volume-chapter'||!row.prefix||row.prefix==='正文'||/^(?:卷|第[\d一二三四五六七八九十百千万]+[卷部])/.test(row.prefix)||(prefixCounts.get(row.prefix)||0)>=3;
  const next=rows[i+1];
  const formal=(!row.embedded||row.repaired)&&['章','回','折'].includes(row.unit)&&row.raw.length<=85&&!/[。]/.test(row.title)&&stablePrefix;
  const parent=formal&&next&&next.start-row.end<100&&(next.number===1||next.unit!==row.unit);
  let prevNumber=null,nextNumber=null;
  if(!row.unit&&row.raw.length<=70){for(let n=i-1;n>=0;n--)if(rows[n].family===row.family){prevNumber=rows[n].number;break;}for(let n=i+1;n<rows.length;n++)if(rows[n].family===row.family){nextNumber=rows[n].number;break;}}
  const sequence=!row.unit&&row.gap>=200&&((prevNumber===row.number-1&&nextNumber===row.number+1)||(row.number===1&&nextNumber===2));
  if(formal||sequence){selected.set(row.id,{...row,kind:'chapter',source:'model-approved-source-structure'});restored.push({id:row.id,index:row.index,line:row.raw,reason:parent?'explicit-parent-heading':sequence?'continuous-source-sequence':row.gap<200?'adjacent-source-heading-conflict':'explicit-source-heading'});}
 }
 return restored;
}
