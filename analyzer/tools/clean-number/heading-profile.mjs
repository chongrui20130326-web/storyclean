import {isSiteBanner} from './source-text.mjs';
const DIGITS = '0-9０-９零〇○一二三四五六七八九十百千万两兩壹贰貳叁參肆伍陆陸柒捌玖拾佰仟廿卅卌';
const chapterMarker = new RegExp(`第\\s*([${DIGITS}\\s]{1,32}?)\\s*([章回节折])`, 'g');
const volumeMarker = new RegExp(`^(?:卷[${DIGITS}]+|[${DIGITS}]+卷|第[${DIGITS}\\s]+[卷部集篇])`);
const values = {零:0,〇:0,'○':0,一:1,壹:1,二:2,两:2,兩:2,贰:2,貳:2,三:3,叁:3,參:3,四:4,肆:4,五:5,伍:5,六:6,陆:6,陸:6,七:7,柒:7,八:8,捌:8,九:9,玖:9};
export function chineseOrdinal(value) {
  let text=String(value).normalize('NFKC').replace(/\s/g,'').replace(/廿/g,'二十').replace(/卅/g,'三十').replace(/卌/g,'四十');
  if(/^\d+$/.test(text))return Number(text);
  text=[...text].map(c=>values[c]===undefined?c:String(values[c])).join('');
  if(/^\d+$/.test(text))return Number(text);
  const unit={十:10,拾:10,百:100,佰:100,千:1000,仟:1000,万:10000};let total=0,section=0,n=0,lastUnit=1;
  const tokens=text.match(/\d+|[十拾百佰千仟万]/g)||[];
  if(tokens.join('')!==text)return null;
  for(let i=0;i<tokens.length;i++) {const c=tokens[i];if(/^\d+$/.test(c)){n=Number(c);if(i===tokens.length-1 && c.length===1 && lastUnit>=100)n*=lastUnit/10;}else {const u=unit[c];if(u===10000){total+=(section+n||1)*u;section=0;}else section+=(n||1)*u;n=0;lastUnit=u;}}
  return total+section+n;
}

const needsTitleBoundaryReview=title=>title.length>100||(title.length>=18&&/[。]/.test(title));

function parseExportedHeading(line,{allowLong=false}={}){
  const match=line.match(new RegExp(`^《([^》\\n]{1,120})》\\s*([（(])第\\s*([${DIGITS}\\s]{1,32}?)\\s*([章回节折])`));
  if(!match)return null;
  const rest=line.slice(match[0].length);if(!/^[\s]*(?:[·・]|[）)])/.test(rest))return null;
  let depth=1,close=-1;for(let i=match[0].length;i<line.length;i++){const c=line[i];if(c==='（'||c==='(')depth++;else if(c==='）'||c===')'){depth--;if(depth===0){close=i;break;}}}
  if(close<0)return null;
  const middle=line.slice(match[0].length,close).trim();if(middle&&!/^[·・]/.test(middle))return null;
  const number=chineseOrdinal(match[3]);if(number===null)return null;
  const title=line.slice(close+1).trim(),needsBoundaryRepair=needsTitleBoundaryReview(title);if(title.length>100&&!allowLong)return null;
  return {number,title,unit:match[4],prefix:'',offset:0,embedded:false,needsBoundaryRepair,family:`chapter-${match[4]}`,volumeLabel:middle.replace(/^[·・]/,'').trim(),sourceBookName:match[1],standardized:true};
}

export function parseSourceHeading(raw, { allowEmbedded = false, allowLong = false } = {}) {
  const line=String(raw).trim(); if(!line)return null;
  const dated=line.match(/^(\d{4}(?:年\s*\d{1,2}月\s*\d{1,2}日|[-/.]\d{1,2}[-/.]\d{1,2}))\s*(?=(?:[【\[]\s*)?第)/);
  if(dated){const rest=line.slice(dated[0].length),parsed=parseSourceHeading(rest,{allowEmbedded,allowLong});if(parsed)return {...parsed,offset:dated[0].length+parsed.offset,endOffset:dated[0].length+(parsed.endOffset??rest.length),sourceDate:dated[1]};}
  const exported=parseExportedHeading(line,{allowLong});if(exported)return exported;
  const frame=line.match(/^(?:《([^》]{1,120})》\s*)?([【\[])/);
  if(frame){
    const open=frame[0].length-1,stack=[];let close=-1;
    for(let i=open;i<line.length;i++){const c=line[i];if(c==='【'||c==='[')stack.push(c);else if(c==='】'||c===']'){if(stack.pop()!==(c==='】'?'【':'['))break;if(!stack.length){close=i;break;}}}
    if(close>open){const parsed=parseSourceHeading(line.slice(open+1,close),{allowEmbedded:false,allowLong:true});if(parsed&&parsed.offset===0)return {...parsed,offset:0,endOffset:close+1,framed:true,sourceBookName:frame[1]||parsed.sourceBookName,needsBoundaryRepair:false};}
  }
  const matches=[...line.matchAll(chapterMarker)];
  if(matches.length){
    const match=matches[0];let prefix=line.slice(0,match.index).trim();if(/^[【\[]/.test(prefix)&&volumeMarker.test(prefix.slice(1)))prefix=prefix.slice(1).trim();if(/^[@#*·•\-=—\s]+$/.test(prefix))prefix='';const title=line.slice(match.index+match[0].length).replace(/<[^>]*>/g,'').trim().replace(/^[-:：、.．]\s*/,'');
    const needsBoundaryRepair=needsTitleBoundaryReview(title);
    if((title.length>100&&!allowLong) || (match[2]==='回'&&/^合/.test(title)))return null;
    const embedded=prefix.length>42 || /[。！？!?“”「」『』]/.test(prefix);
    if(embedded&&!allowEmbedded)return null;
    const number=chineseOrdinal(match[1]);if(number===null)return null;
    return {number,title,unit:match[2],prefix:embedded?'':prefix,offset:embedded?match.index:0,embedded,needsBoundaryRepair,family:embedded?'embedded-chapter':volumeMarker.test(prefix)?'volume-chapter':prefix&&prefix!=='正文'?'prefixed-chapter':`chapter-${match[2]}`,volumeLabel:!embedded&&prefix&&prefix!=='正文'?prefix:''};
  }
  const numeric=line.match(new RegExp(`^([${DIGITS}]{1,20})([.．、)）]|\\s{1,8})([^\\n]{1,100})$`));
  if(!numeric)return null;
  if(/^\d+[.．]\d+\s*(?:秒|分钟|小时|公里|千米|米|厘米|毫米|倍|岁|%|％)/.test(line))return null;
  const number=chineseOrdinal(numeric[1]);if(number===null)return null;
  const title=numeric[3].replace(/<[^>]*>/g,'').trim();if(!title)return null;
  const family=/^\s/.test(numeric[2])?'number-space':/^[0-9０-９]/.test(numeric[1])?'number-punctuation':'chinese-punctuation';
  return {number,title,unit:'',prefix:'',offset:0,embedded:false,family,volumeLabel:''};
}

export function profileHeadings(text) {
  const source=String(text);const lines=source.split('\n');const rows=[];let offset=0;let previous=null;const duplicates=[];
  for(let index=0;index<lines.length;index++){
    const original=lines[index];const trimmed=original.trim();
    const allMarkers=[...trimmed.matchAll(chapterMarker)];
    const markers=allMarkers.filter(m=>m[2]===allMarkers[0]?.[2]);
    const exported=parseExportedHeading(trimmed,{allowLong:true})||(/^(?:《[^》]+》\s*)?[【\[]|^\d{4}(?:年|[-/.])/.test(trimmed)?parseSourceHeading(trimmed,{allowEmbedded:true,allowLong:true}):null);
    const pieces=!exported&&markers.length>1?markers.map((m,i)=>({from:i?m.index:0,to:markers[i+1]?.index??trimmed.length})): [{from:0,to:trimmed.length}];
    for(const piece of pieces){const segment=trimmed.slice(piece.from,piece.to);const firstMarker=[...segment.matchAll(chapterMarker)][0];const allowLong=firstMarker&&(firstMarker.index===0||volumeMarker.test(segment.slice(0,firstMarker.index)));const parsed=exported||parseSourceHeading(segment,{allowEmbedded:true,allowLong});if(parsed){
      const leading=original.indexOf(trimmed);const start=offset+leading+piece.from+parsed.offset;const end=offset+leading+piece.from+(parsed.endOffset??(piece.to-piece.from));
      if(piece.from){const compound=allMarkers[0]?.index===0||volumeMarker.test(trimmed.slice(0,allMarkers[0]?.index));parsed.embedded=!compound;parsed.compoundHeading=compound;parsed.family=compound?`chapter-${parsed.unit}`:'embedded-chapter';}
      const row={...parsed,index,start,end,raw:source.slice(start,end).trim(),line:segment,id:`L${index}C${leading+piece.from+parsed.offset}`,before:'',after:'',duplicateOf:null};
      rows.push(row);
    }}
    offset+=original.length+1;
  }
  // 单次出现的任意短前缀未必是篇名；应保留在正文中，不能随章标题一起删除。
  const prefixes=new Map();const standalone=new Set(lines.map(line=>line.trim()));
  for(const row of rows)if(row.family==='prefixed-chapter'){if(!prefixes.has(row.prefix))prefixes.set(row.prefix,new Set());prefixes.get(row.prefix).add(JSON.stringify([row.number,row.title]));}
  for(const row of rows)if(row.family==='prefixed-chapter'&&prefixes.get(row.prefix).size<2&&!standalone.has(row.prefix)){
    const marker=[...row.raw.matchAll(chapterMarker)][0];if(marker&&marker.index>0){row.start+=marker.index;row.id=`L${row.index}C${Number(row.id.split('C')[1])+marker.index}`;row.raw=source.slice(row.start,row.end).trim();row.prefix='';row.volumeLabel='';row.family='embedded-chapter';row.embedded=true;}
  }
  duplicates.push(...refreshDuplicateHeadings(source,rows));
  const nearest=(index,direction)=>{for(let i=index+direction;i>=0&&i<lines.length;i+=direction){const t=lines[i].trim();if(t)return t.slice(0,100);}return '';};
  for(let i=0;i<rows.length;i++){const r=rows[i];r.before=r.embedded?lines[r.index].slice(0,lines[r.index].indexOf(r.raw)).slice(-100):nearest(r.index,-1);r.after=nearest(r.index,1);r.gap=rows[i+1]?rows[i+1].start-r.end:source.length-r.end;}
  const signature=r=>JSON.stringify([r.number,r.unit,r.title.replace(/\s/g,'')]);const copies=new Map();
  for(const row of rows.filter(r=>!r.duplicateOf)){const key=signature(row);if(!copies.has(key))copies.set(key,[]);copies.get(key).push(row);}
  for(let first=0;first<rows.length;){let last=first;while(last+1<rows.length&&rows[last].gap<100){if(last-first>=1&&rows[last+1].gap>=200&&rows[last+1].number<=rows[last].number)break;last++;}if(last>first){const group=rows.slice(first,last+1).filter(r=>!r.duplicateOf);const later=group.map(r=>(copies.get(signature(r))||[]).find(c=>c.start>rows[last].end));if(group.length>=2&&later.every(Boolean)&&later.some(r=>r.gap>=200))for(const r of group)r.structuralRole='toc-entry';}first=last+1;}
  // 明确“目录”下的密集标题允许带装饰括号或副标题；正文可能只保留章号。
  for(let first=0;first<rows.length;){let last=first;while(last+1<rows.length&&!source.slice(rows[last].end,rows[last+1].start).trim()){
      if(last-first>=2&&rows[last+1].gap>=200&&rows[last+1].number<=rows[last].number)break;
      last++;
    }
    const group=rows.slice(first,last+1);const labelled=/目\s*录\s*$/.test(source.slice(Math.max(0,group[0].start-40),group[0].start));
    if(labelled&&group.length>=3&&group.every(r=>rows.some(c=>c.start>rows[last].end&&c.number===r.number&&c.unit===r.unit&&c.gap>=200)))for(const r of group)r.structuralRole='toc-entry';first=last+1;
  }
  const anchors=rows.filter(r=>!r.duplicateOf&&!r.embedded&&r.unit&&r.unit!=='节'&&!/[。]/.test(r.raw));
  const numberedLists=rows.filter(r=>!r.duplicateOf&&!r.unit);
  if(anchors.length>=3){
    const groups=new Map();for(const row of numberedLists){if(!groups.has(row.family))groups.set(row.family,[]);groups.get(row.family).push(row);}
    for(const entries of groups.values())if(entries.length<8&&entries.every(r=>/[。！？!?]$/.test(r.raw))){
      const before=anchors.findLast(a=>a.start<entries[0].start);const after=anchors.find(a=>a.start>entries.at(-1).start);
      if(before&&after)for(const r of entries)r.structuralRole='nested-narrative-list';
    }
  }
  const anchoredUnits=new Set(anchors.map(r=>r.unit));
  for(const row of rows)if(row.embedded&&['回','节'].includes(row.unit)&&/[。！？!?…][”’」』）)]*$/.test(row.raw)&&!anchoredUnits.has(row.unit))row.structuralRole='narrative-unit-mention';
  for(const row of rows){
    if(row.standardized||row.framed)continue;
    if(isSiteBanner(row.raw)){row.structuralRole='site-banner';continue;}
    if(/(?:为你提供最快|请退出转码|请下载.*app|你正在阅读|方便以后阅读)/i.test(row.line)){row.structuralRole='site-chapter-reference';continue;}
    if(/免费阅读[。.！!]?$/i.test(row.raw)&&row.gap<100){
      const next=rows[rows.indexOf(row)+1];const previous=rows.findLast(r=>r.start<row.start&&r.number===row.number&&r.unit===row.unit&&r.gap>=200&&row.start-r.start<50000);
      if(previous&&next&&!source.slice(row.end,next.start).replace(/[\s\-=*_#]/g,'')){row.structuralRole='site-chapter-footer';continue;}
    }
    if(/^(?:[（(]?\s*(?:PS[:：]|P\.S\.|上一章|这一章)).*(?:应该|打错|笔误|更正)/i.test(row.line)){row.structuralRole='author-chapter-correction';continue;}
    const beforeHigh=rows.findLast(r=>r.start<row.start&&r.unit===row.unit&&r.number>row.number&&r.gap>=200&&r.title.length<=70&&!r.structuralRole&&!/[。]/.test(r.title));
    const afterHigh=beforeHigh&&rows.find(r=>r.start>row.start&&r.unit===row.unit&&r.number>=beforeHigh.number&&r.gap>=200&&r.title.length<=70&&!r.structuralRole&&!/[。]/.test(r.title));
    const lowReference=beforeHigh&&afterHigh&&afterHigh.start-beforeHigh.end<50000;
    const updateContext=/(?:月票|推荐票|订阅|发布完|写完|求(?:月票|推荐|订阅)|去写|去努力|继续.*写|码字|不要等|别等|晚间还有|明天.*(?:更|放|中午)|零点更|更过了|更新时间|睡过去|强撑|昏迷|存稿|迟一点|咯[~～]|送上[~～]|给大家送上|写[得的].*(?:卡|改|慢)|才上传|截止现在|请假)/.test(lines[row.index])
      ||/^(?:完(?:毕)?(?:[。！？!，,]|$)|到(?:了)?(?:[，。！？!…]|呼唤|$)|又到后半夜|太晚.*明天)/.test(row.title)
      ||(/更新时间/.test(lines.slice(Math.max(0,row.index-6),row.index).join('\n'))&&/(?:中午|傍晚|晚上|早上|零点|\d+点)/.test(row.title));
    if(lowReference&&(updateContext||!row.title||/^[，,。]/.test(row.title)||/^[与和的也去咯~～，。！!（）)]+$/.test(row.title))){row.structuralRole='in-chapter-update-reference';continue;}
    const authorContext=/(?:未完待续|月票|推荐票|订阅|支持作者|上传|断更|屏蔽|主站|书城|码字|去写|再发一章|迟一点|更迟一些|没能及时传|送上[~～]|咯[！!]|还会有一章|会在今晚|零点.*(?:章|会|发)|今天.*(?:章|更新)|今晚.*(?:章|更新)|不要等|别等了|去努力|会很晚|会很早|早上起来看|大家不要错过|去[。！]$)/.test(row.raw);
    const prosePunctuation=/^[，,。]/.test(row.title);
    const proseForm=prosePunctuation||row.embedded||/[（(]/.test(row.prefix)||/[）)]$/.test(row.raw);
    const unique=rows.filter(r=>!r.duplicateOf&&r.unit===row.unit&&r.number===row.number).length===1;
    const adjacent=rows.some(r=>!r.duplicateOf&&r.unit===row.unit&&((r.number===row.number-1&&r.start<row.start&&row.start-r.start<50000)||(r.number===row.number+1&&r.start>row.start&&r.start-row.start<50000)));
    if(row.embedded&&row.title.length>40&&/[。.!！?？].*[。.!！?？]/.test(row.title)){
      if(adjacent){row.needsBoundaryRepair=true;continue;}row.structuralRole='embedded-narrative-reference';continue;
    }
    if(authorContext&&proseForm&&['章','回','折'].includes(row.unit)&&unique&&adjacent){row.needsBoundaryRepair=true;continue;}
    if(row.title.length<=100&&((authorContext&&proseForm)||prosePunctuation))row.structuralRole='author-note-or-narrative-reference';
    if(row.embedded&&(/^(?:后[，,]|中[，,]|里[，,])/.test(row.title)||(/问[:：]/.test(row.line)&&/答[:：]/.test(row.raw))||/方便.*阅读.*最新章节/.test(row.raw)))row.structuralRole='narrative-chapter-reference';
    if(!row.unit&&new RegExp(`^[${DIGITS}]+(?:[、，,][${DIGITS}]+){2,}`).test(row.raw))row.structuralRole='numeric-enumeration';
  }
  // 数字章节内部也会重新出现 1、2、3 列表：以两侧承接的主章号确定层级。
  const numericRows=rows.filter(r=>!r.unit&&!r.duplicateOf&&!r.structuralRole);
  if(anchors.length<3&&numericRows.length>=20){
    const counts=new Map();for(const row of numericRows)counts.set(row.number,(counts.get(row.number)||0)+1);
    const eligible=numericRows.filter(r=>counts.get(r.number)===1&&r.gap>=200&&r.raw.length<=70);
    const main=eligible.filter(r=>eligible.some(n=>Math.abs(n.start-r.start)<50000&&((n.number===r.number-1&&n.start<r.start)||(n.number===r.number+1&&n.start>r.start))));
    for(const row of numericRows){
      if(!/[。！？!?…][”’」』）)]*$/.test(row.raw))continue;
      const before=main.findLast(r=>r.start<row.start);
      if(!before||before.number<=row.number)continue;
      const after=main.find(r=>r.start>row.start);
      if(after&&after.number>before.number&&after.start-before.end<=50000)row.structuralRole='nested-numbered-prose';
    }
  }
  for(const row of rows)if((row.embedded||row.prefix)&&((row.title&&/^[。！？!?，,：:;；“”‘’「」『』）)】\]]+$/.test(row.title))||(!row.title&&/[、，,。：“”！？]$/.test(row.raw))))row.structuralRole='quoted-chapter-mention';
  const families=new Map();for(const row of rows.filter(r=>!r.duplicateOf&&!r.structuralRole)){if(!families.has(row.family))families.set(row.family,[]);families.get(row.family).push(row);}
  return {rows,duplicates,families:[...families].map(([id,entries])=>({id,count:entries.length,samples:Array.from(new Set([0,1,Math.floor(entries.length/3),Math.floor(entries.length*2/3),entries.length-2,entries.length-1])).filter(i=>i>=0&&i<entries.length).map(i=>entries[i])}))};
}

export function refreshDuplicateHeadings(source,rows){
 const duplicates=[];let previous=null;for(const r of rows)r.duplicateOf=null;
 for(const row of rows){const sameTitle=previous&&row.title&&previous.title.replace(/\s/g,'')===row.title.replace(/\s/g,'');if(previous&&!previous.needsBoundaryRepair&&!row.needsBoundaryRepair&&previous.unit===row.unit&&(previous.number===row.number||sameTitle)){
   const between=source.slice(previous.end,row.start).replace(/<[^>]*>/g,'').replace(/[（(]求(?:月票|推荐票|推荐|订阅|收藏)[^（）()\n]{0,40}[）)]/g,'').replace(/[\s\-=*_#]/g,'');if(!between){previous.duplicateOf=row.id;duplicates.push({id:previous.id,kept:row.id,line:previous.raw,start:previous.start,end:previous.end});}
  }previous=row;
 }
 const byId=new Map(rows.map(r=>[r.id,r]));for(const d of duplicates){let row=byId.get(d.kept);while(row?.duplicateOf)row=byId.get(row.duplicateOf);if(row)d.kept=row.id;}
 return duplicates;
}

export function headingMarkerOffset(raw){return [...String(raw).matchAll(chapterMarker)][0]?.index??0;}
