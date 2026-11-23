const parse=result=>{
 const raw=String(result.content||'');const start=raw.indexOf('{');const source=raw.slice(start);const stack=[];let quoted=false,escaped=false,invalid=false;
 for(let i=0;i<source.length;i++){
  const c=source[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
  if(c==='"'){quoted=true;continue;}if(c==='{'||c==='[')stack.push(c);
  else if(c==='}'||c===']'){if(stack.pop()!==(c==='}'?'{':'[')){invalid=true;break;}if(!stack.length)return JSON.parse(source.slice(0,i+1));}
 }
 // 只补模型遗漏的唯一根对象闭合符；不补数组项、字符串或任何字段值。
 if(start>=0&&!invalid&&!quoted&&stack.length===1&&stack[0]==='{'&&/[\]}]\s*$/.test(source))return JSON.parse(source.trim()+'}');
 return JSON.parse(raw.slice(start,raw.lastIndexOf('}')+1));
};
export async function askJson(chat,input){
 try{return parse(await chat(input));}catch(error){if(!(error instanceof SyntaxError))throw error;return parse(await chat({...input,prompt:input.prompt+'\n上次响应不是合法 JSON。请重新检查所有双引号和逗号，只返回所要求的 JSON 字段，不要解释或 Markdown。'}));}
}
export async function checkedBatch(chat,request,rows,kind,depth=0){
 try{
  const data=await askJson(chat,{...request,prompt:request.prefix+JSON.stringify(rows)});const ids=new Set(rows.map(r=>r.id));
  if(kind==='review'){
   if(!Array.isArray(data.reject))throw Error('结构复核缺少 reject 数组');
   for(const r of data.reject)if(!ids.has(typeof r==='string'?r:r.id))throw Error('结构复核返回无效定位标识');
   for(const r of data.special||[])if(!ids.has(r.id)||!['preface','afterword','appendix','volume'].includes(r.kind))throw Error('附属篇目返回无效定位标识或分类');
  }else{
   if(!Array.isArray(data.decisions))throw Error('剔除确认缺少 decisions');const seen=new Set();
   for(const d of data.decisions){if(!ids.has(d.id)||seen.has(d.id)||typeof d.keep!=='boolean')throw Error('剔除确认定位标识或结果无效');seen.add(d.id);}
   if(seen.size!==ids.size)throw Error('剔除确认遗漏候选');
  }
  return [{batch:rows,data}];
 }catch(error){
  if(depth>=2||rows.length<2||(!(error instanceof SyntaxError)&&!/无效|缺少|遗漏/.test(error.message)))throw error;
  const middle=Math.ceil(rows.length/2);
  return [...await checkedBatch(chat,request,rows.slice(0,middle),kind,depth+1),...await checkedBatch(chat,request,rows.slice(middle),kind,depth+1)];
 }
}
