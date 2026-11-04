import DOMPurify from 'dompurify';
let queue:Promise<unknown>=Promise.resolve();
let serial=0;
/** Mermaid is display-only. Serialize its global configuration, return inert SVG. */
export function renderMessageDiagram(source:string,dark:boolean):Promise<string>{
  const result=queue.catch(()=>{}).then(async()=>{
    if(source.length>50000||/%%\s*\{|^\s*---\s*$/m.test(source))throw Error('diagram_source_unsupported');
    const {default:mermaid}=await import('mermaid');
    mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:dark?'dark':'default',htmlLabels:false,
      suppressErrorRendering:true,maxTextSize:50000,flowchart:{htmlLabels:false},
      secure:['securityLevel','startOnLoad','htmlLabels','suppressErrorRendering','maxTextSize']});
    const {svg}=await mermaid.render('assistant-diagram-'+(++serial),source);
    return DOMPurify.sanitize(svg,{USE_PROFILES:{svg:true,svgFilters:true},FORBID_TAGS:['script','foreignObject','a','image','use'],FORBID_ATTR:['href','xlink:href','onload','onclick']});
  });queue=result;return result;
}
