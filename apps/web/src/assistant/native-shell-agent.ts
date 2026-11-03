type AgentChoice={name:string;hidden?:boolean;mode?:string};

/** The native catalog is alphabetically sorted, not default-agent order.
 * Do not infer a default custom agent from its first row. */
export function nativeShellAgent(selection:string,configured:string|undefined,agents:AgentChoice[]){
  if(selection)return selection;
  if(configured)return configured;
  const visible=agents.filter(agent=>!agent.hidden&&agent.mode!=='subagent');
  if(visible.some(agent=>agent.name==='build'))return 'build';
  if(visible.length===1)return visible[0].name;
  throw Error('native_shell_select_agent');
}
