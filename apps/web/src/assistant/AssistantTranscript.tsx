import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import {useRichMessageContext} from './rich-message-context';
import {richMessageText} from './rich-message-copy';
export function AssistantTranscript({children}:{children:ReactNode}){
  const {locale}=useRichMessageContext();const viewport=useRef<HTMLDivElement>(null),content=useRef<HTMLDivElement>(null);
  const follow=useRef(true);const [atEnd,setAtEnd]=useState(true);
  useLayoutEffect(()=>{
    const scroll=()=>{const node=viewport.current;if(follow.current&&node)node.scrollTop=node.scrollHeight;};scroll();
    const observer=new ResizeObserver(scroll);if(content.current)observer.observe(content.current);return ()=>observer.disconnect();
  },[]);
  useLayoutEffect(()=>{if(follow.current&&viewport.current)viewport.current.scrollTop=viewport.current.scrollHeight;});
  return <div className="assistant-transcript-shell"><div className="assistant-transcript" ref={viewport} aria-live="off" onScroll={()=>{
    const node=viewport.current!;const near=node.scrollHeight-node.clientHeight-node.scrollTop<48;follow.current=near;setAtEnd(near);
  }}><div ref={content} className="assistant-transcript-content">{children}</div></div>
    {!atEnd&&<Button className="assistant-jump-latest" variant="secondary" onClick={()=>{follow.current=true;setAtEnd(true);const node=viewport.current!;node.scrollTop=node.scrollHeight;}}>{richMessageText(locale,'latest')}</Button>}
  </div>;
}
