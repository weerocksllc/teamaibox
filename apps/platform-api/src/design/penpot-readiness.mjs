import {PlatformError} from '../../../../packages/observability/src/index.mjs';

function endpoint(origin,path){
  if(!origin)return null;
  const url=new URL(origin);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new TypeError('Invalid private design service origin');
  url.pathname=path;return url;
}

/** Read-only dependency observations, not a design save or AI readiness claim.
 * The browser cannot choose a target; no keys, service addresses or error
 * bodies are exposed. Each observation rechecks the current platform grant. */
export class PenpotReadiness {
  #authentication;#authority;#targets;#fetch;#mcpConfigured;#version;#clock;
  constructor({authentication,authority,frontendOrigin,backendOrigin,exporterOrigin,mcpConfigured=false,fetchImpl=fetch,version=null,clock=()=>new Date()}){
    if(!authentication?.authenticateSession||!authority?.authorizeDesign||typeof fetchImpl!=='function')throw new TypeError('Design readiness requires platform access checks');
    this.#authentication=authentication;this.#authority=authority;this.#fetch=fetchImpl;this.#mcpConfigured=mcpConfigured;
    if(version!==null&&!/^\d+\.\d+\.\d+$/.test(version))throw new TypeError('Invalid design release version');
    this.#version=version;this.#clock=clock;
    this.#targets={frontend:endpoint(frontendOrigin,'/index.html'),backend:endpoint(backendOrigin,'/readyz'),exporter:endpoint(exporterOrigin,'/readyz')};
  }
  async #check(input){
    const context=await this.#authentication.authenticateSession({...input,requireCsrf:true});
    if(!(await this.#authority.authorizeDesign(context)).allowed)throw new PlatformError('penpot_access_denied','Design access is unavailable',{status:403});
  }
  async #observe(){
    const observations=Object.fromEntries(await Promise.all(Object.entries(this.#targets).map(async([name,target])=>{
      if(!target)return [name,'not_configured'];
      try{
        const response=await this.#fetch(target,{method:'GET',redirect:'error',signal:AbortSignal.timeout(2000),headers:{accept:name==='frontend'?'text/html':'application/json'}});
        const ready=response.status===200&&(name!=='frontend'||/^text\/html(?:;|$)/i.test(response.headers.get('content-type')??''));
        await response.body?.cancel();return [name,ready?'ready':'unavailable'];
      }catch{return [name,'unavailable'];}
    })));
    return Object.freeze({editor:observations.frontend==='ready'&&observations.backend==='ready'?'ready':'unavailable',
      dependencies:observations,aiTransport:this.#mcpConfigured?'configured':'not_configured'});
  }
  async inspect(input){
    await this.#check(input);const status=await this.#observe();await this.#check(input);return status;
  }
  /** Internal catalog fact only, not an unauthenticated browser endpoint or
   * generic content proxy. Catalog IAM and native session checks remain intact. */
  async catalogRoute(){
    if(!this.#version)return null;
    const status=await this.#observe();
    return Object.freeze({pluginKey:'official.penpot',pathPrefix:'/api/v1/design/editor/',
      transport:'protected-design-editor',readinessChecked:true,healthy:status.editor==='ready',
      version:this.#version,observedAt:new Date(this.#clock()).toISOString()});
  }
}
