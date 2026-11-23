export function isSiteBanner(input){
 const compact=String(input).replace(/\s/g,'');
 return /^[\p{Script=Han}\d]{0,12}(?:https?:\/\/|www\.)[a-z\d.-]+\.(?:com|net|org|cn|cc|info)\/?$/iu.test(compact);
}
export function normalizeNovelContent(input) {
  let text=String(input||'').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  if(/<!doctype\b|<html\b|<h[1-6]\b|<p\b|<div\b|<(strong|b|a|font)\b[^>]*>[^]*?<\/\1\s*>/i.test(text))text=text.replace(/<!--[^]*?-->/g,'').replace(/<(head|script|style)\b[^>]*>[^]*?<\/\1\s*>/gi,'\n').replace(/<\/?(?:p|div|h[1-6]|br|html|body|section|article)\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,'');
  return text.replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(Math.min(0x10ffff,parseInt(n,16)))).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Math.min(0x10ffff,Number(n)))).replace(/&nbsp;/gi,' ').replace(/&quot;/gi,'"').replace(/&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&amp;/gi,'&');
}
