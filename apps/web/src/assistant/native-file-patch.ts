/** A full-context unified patch keeps the native git-apply conflict check.
 * No file writes or overwrite fallback occur in the product server. */
export function nativeFilePatch(path:string,before:string|null,after:string) {
  if(!path||path.startsWith('/')||/[\\\r\n\0\t"]/u.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('invalid_file_path');
  if(before===after)return '';
  const lines=(text:string)=>text===''?[]:text.endsWith('\n')?text.slice(0,-1).split('\n'):text.split('\n');
  const old=lines(before??''),next=lines(after);
  const body=(items:string[],prefix:string,source:string)=>items.map((line,i)=>`${prefix}${line}\n${i===items.length-1&&!source.endsWith('\n')?'\\ No newline at end of file\n':''}`).join('');
  if(before===null&&!after)throw Error('empty_new_file_patch');
  return `diff --git a/${path} b/${path}\n${before===null?'new file mode 100644\n':''}--- ${before===null?'/dev/null':`a/${path}`}\n+++ b/${path}\n@@ -${old.length?1:0},${old.length} +${next.length?1:0},${next.length} @@\n${body(old,'-',before??'')}${body(next,'+',after)}`;
}
