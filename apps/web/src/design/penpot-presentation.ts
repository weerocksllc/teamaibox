// Pin this check to the authenticated Penpot document, not the iframe's
// about:blank or load event. Penpot applies its own theme after boot.
export function observePenpotPresentation(frame:HTMLIFrameElement,ready:()=>void){
  const doc=frame.contentDocument;
  const win=frame.contentWindow;
  if(!doc||!win||!doc.body||!doc.location||
     doc.location.origin!==frame.ownerDocument.location?.origin||
     doc.location.pathname!=='/api/v1/design/editor/')return;
  const app=doc.getElementById('app');
  if(!app)return;
  const body=doc.body;
  const observer=new (win as Window & typeof globalThis).MutationObserver(check);
  function check(){
    if(!app?.firstElementChild||(!body.classList.contains('default')&&!body.classList.contains('light')))return;
    observer.disconnect();
    ready();
  }
  observer.observe(body,{attributes:true,attributeFilter:['class']});
  observer.observe(app,{childList:true});
  check();
  return ()=>observer.disconnect();
}
