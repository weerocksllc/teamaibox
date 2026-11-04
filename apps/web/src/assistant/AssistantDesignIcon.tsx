/** Exact exported Figma assets. Masks retain semantic theme colors. */
const icons={folder:'82a45',chat:'56d3b',file:'8faf0',search:'e713d',plus:'a4271',command:'67023',more:'75ee7',spark:'a9da4',paperclip:'818d9',send:'7838a',close:'b9037',right:'d097e',check:'7c22b'} as const;
export function AssistantDesignIcon({name}:{name:keyof typeof icons}){
  return <span className={`assistant-design-icon assistant-design-icon--${name}`} aria-hidden="true" style={{maskImage:`url(/brand/assistant/${icons[name]}.svg)`}}/>;
}
