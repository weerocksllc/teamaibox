import {Component,memo,useEffect,useMemo,useState,type ReactNode} from 'react';
import {Streamdown,defaultRemarkPlugins,useIsCodeFenceIncomplete,type Components} from 'streamdown';
import {createMathPlugin} from '@streamdown/math';
import hljs from 'highlight.js/lib/common';
import {Button} from '@teamaibox/ui-system/components';
import {AssistantImage} from './AssistantMessageMedia';
import {safeMessageLink} from './message-media';
import {useRichMessageContext} from './rich-message-context';
import {richMessageText} from './rich-message-copy';
import 'katex/dist/katex.min.css';

const imageMarker='/assistant-message-image/';
type MarkdownNode={type:string;url?:string;value?:string;children?:MarkdownNode[]};
// A display adapter, not a parser: keep image references intact through the
// library's URL sanitization, then resolve them only in our inert media control.
function messageNodes(){return (root:unknown)=>{
  function visit(node:MarkdownNode){
    if(node.type==='image'&&node.url!==undefined)node.url=imageMarker+encodeURIComponent(node.url);
    if(node.type==='html')node.type='text';
    node.children?.forEach(visit);
  }visit(root as MarkdownNode);
};}
const remarkPlugins=[...Object.values(defaultRemarkPlugins),messageNodes];
const plugins={math:{...createMathPlugin({singleDollarTextMath:true}),getStyles:undefined}};

function Diagram({source,incomplete}:{source:string;incomplete:boolean}){
  const {locale}=useRichMessageContext();const t=(key:Parameters<typeof richMessageText>[1])=>richMessageText(locale,key);
  const [dark,setDark]=useState(()=>document.documentElement.dataset.theme==='dark');
  const [state,setState]=useState<{source:string;url?:string;failed?:boolean}>({source});
  const [showSource,setShowSource]=useState(false);
  useEffect(()=>{const observer=new MutationObserver(()=>setDark(document.documentElement.dataset.theme==='dark'));observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});return ()=>observer.disconnect();},[]);
  useEffect(()=>{
    let disposed=false,url:string|undefined;setState({source});
    if(incomplete)return;
    void import('./mermaid-renderer').then(m=>m.renderMessageDiagram(source,dark)).then(svg=>{
      if(disposed)return;url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));setState({source,url});
    }).catch(()=>{if(!disposed)setState({source,failed:true});});
    return ()=>{disposed=true;if(url)URL.revokeObjectURL(url);};
  },[source,dark,incomplete]);
  const current=state.source===source?state:undefined;
  return <div className="assistant-diagram"><header><span>{t('diagram')}</span>{current?.url&&<Button variant="quiet" aria-pressed={showSource} onClick={()=>setShowSource(v=>!v)}>{t('source')}</Button>}</header>
    {current?.url&&!showSource?<img src={current.url} alt={t('diagram')}/>:<pre dir="ltr"><code>{source}</code></pre>}
    {current?.failed&&<small role="status">{t('diagramError')}</small>}
  </div>;
}
function Code({source,language,incomplete}:{source:string;language:string;incomplete:boolean}){
  const {locale}=useRichMessageContext();const t=(key:Parameters<typeof richMessageText>[1])=>richMessageText(locale,key);
  const [copy,setCopy]=useState<'copy'|'copied'|'copyFailed'>('copy');
  const highlighted=useMemo(()=>{if(!hljs.getLanguage(language)||source.length>100000)return null;try{return hljs.highlight(source,{language,ignoreIllegals:true}).value;}catch{return null;}},[source,language]);
  useEffect(()=>setCopy('copy'),[source]);
  async function copyCode(){try{await navigator.clipboard.writeText(source);setCopy('copied');}catch{setCopy('copyFailed');}}
  return <div className="assistant-code" data-language={language||'text'} data-incomplete={incomplete||undefined}>
    <header><span>{language||'text'}</span><Button variant="quiet" onClick={()=>void copyCode()}>{t(copy)}</Button></header>
    {language==='mermaid'?<Diagram source={source} incomplete={incomplete}/>:<pre dir="ltr">{highlighted?<code className="hljs" dangerouslySetInnerHTML={{__html:highlighted}}/>:<code>{source}</code>}</pre>}
  </div>;
}
const components:Components={
  // Product CSS does not use Tailwind; preserve semantic emphasis directly.
  strong:({children})=><strong>{children}</strong>,
  pre:({node})=>{
    const incomplete=useIsCodeFenceIncomplete();const code=node?.children.find(n=>n.type==='element'&&n.tagName==='code');
    if(!code||code.type!=='element')return null;
    const source=code.children.map(n=>n.type==='text'?n.value:'').join('').replace(/\n$/,'');
    const classes=Array.isArray(code.properties?.className)?code.properties.className:[];
    const language=String(classes.find(c=>String(c).startsWith('language-'))??'').replace(/^language-/,'').toLowerCase();
    return <Code source={source} language={language} incomplete={incomplete}/>;
  },
  a:({href,children})=>{const safe=safeMessageLink(href);return safe?<a href={safe} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a>:<span>{children}</span>;},
  img:({src,alt})=>{let source='';try{source=typeof src==='string'&&src.startsWith(imageMarker)?decodeURIComponent(src.slice(imageMarker.length)):'';}catch{}return <AssistantImage src={source} alt={alt}/>;},
  table:({children})=><div className="assistant-markdown-table" tabIndex={0}><table>{children}</table></div>,
};
class RenderBoundary extends Component<{source:string;children:ReactNode},{failed:boolean}>{
  state={failed:false};static getDerivedStateFromError(){return {failed:true};}
  componentDidUpdate(previous:{source:string}){if(this.state.failed&&previous.source!==this.props.source)this.setState({failed:false});}
  render(){return this.state.failed?<pre className="assistant-rich-fallback">{this.props.source}</pre>:this.props.children;}
}
export const AssistantRichText=memo(function AssistantRichText({text,streaming=false}:{text:string;streaming?:boolean}){
  return <RenderBoundary source={text}><Streamdown className="assistant-rich-text" mode="streaming" dir="auto" isAnimating={streaming} parseIncompleteMarkdown={streaming} plugins={plugins} remarkPlugins={remarkPlugins} components={components} controls={false} skipHtml linkSafety={{enabled:false}}>{text}</Streamdown></RenderBoundary>;
});
