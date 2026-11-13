const editorPath='/api/v1/design/editor/';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type CanvasPanel='layers'|'properties'|null;
export type CanvasFile={id:string;name:string;saveText:string;saved:boolean};

/** This adapter is presentation-only, for the pinned native editor. The
 * authenticated iframe still owns edits, pointer handling and save state. */
export function observeCanvas(frame:HTMLIFrameElement, stylesheet:string, update:(file:CanvasFile|null)=>void){
  const win=frame.contentWindow as (Window & typeof globalThis)|null, doc=frame.contentDocument;
  const parent=frame.ownerDocument.location;
  if(!parent||!win||!doc||!doc.body||win.location.origin!==parent.origin||win.location.pathname!==editorPath){update(null);return;}
  const html=doc.documentElement;
  const css=doc.createElement('link');
  css.rel='stylesheet';css.href=new URL(stylesheet,parent.href).href;
  doc.head.append(css);
  let dashboard='',fileId='',scheduled=0;
  const sync=()=>{
    scheduled=0;
    const [route,query]=win.location.hash.split('?',2);
    if(route.startsWith('#/dashboard/'))dashboard=win.location.hash;
    const recent=route==='#/dashboard/recent';
    html.toggleAttribute('data-tab-design-recent',recent);
    frame.toggleAttribute('data-tab-design-recent',recent);
    const id=new URLSearchParams(query).get('file-id')??'';
    const next=route==='#/workspace'&&uuid.test(id)?id:'';
    if(next!==fileId)delete html.dataset.tabDesignPanel;
    fileId=next;html.toggleAttribute('data-tab-design-canvas',Boolean(fileId));
    const name=doc.querySelector('#left-sidebar-aside .main_ui_workspace_left_header__file-name')?.getAttribute('title')??'';
    const save=doc.querySelector('#left-sidebar-aside .main_ui_workspace_left_header__status-notification');
    update(fileId?{id:fileId,name,saveText:save?.getAttribute('title')??'',
      saved:Boolean(save?.classList.contains('main_ui_workspace_left_header__saved-status'))}:null);
  };
  const queue=()=>{if(!scheduled)scheduled=win.requestAnimationFrame(sync);};
  const observer=new win.MutationObserver(queue);
  observer.observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:['title']});
  win.addEventListener('hashchange',queue);
  const dismiss=(event:KeyboardEvent)=>{
    if(event.key==='Escape'&&html.dataset.tabDesignPanel){delete html.dataset.tabDesignPanel;frame.dispatchEvent(new Event('design-panel-dismiss'));}
  };
  win.addEventListener('keydown',dismiss);
  sync();
  return {
    setPanel(panel:CanvasPanel){if(panel)html.dataset.tabDesignPanel=panel;else delete html.dataset.tabDesignPanel;},
    back(){
      const saved=doc.querySelector('#left-sidebar-aside .main_ui_workspace_left_header__saved-status');
      if(!fileId||!saved)return;
      const team=new URLSearchParams(win.location.hash.split('?')[1]).get('team-id')??'';
      if(dashboard)win.location.hash=dashboard;
      else if(uuid.test(team))win.location.hash='#/dashboard/recent?team-id='+team;
    },
    dispose(){observer.disconnect();win.removeEventListener('hashchange',queue);win.removeEventListener('keydown',dismiss);
      if(scheduled)win.cancelAnimationFrame(scheduled);css.remove();delete html.dataset.tabDesignPanel;html.removeAttribute('data-tab-design-canvas');
      html.removeAttribute('data-tab-design-recent');frame.removeAttribute('data-tab-design-recent');},
  };
}
