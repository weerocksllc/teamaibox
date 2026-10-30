// A tab-local navigation pointer, never a credential or an ownership decision.
// Resolve only against the freshly authenticated owner's list after reload.
const KEY='teamaibox.virtual-phone.selection.v1',UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function phoneSelection(storage){
  const clear=()=>{try{storage?.removeItem(KEY);}catch{}};
  return {clear,remember(id){if(!UUID.test(id??''))return clear();try{storage?.setItem(KEY,id);}catch{}},
    resolve(hash,phones){
      let id=/^#phone=([a-f0-9-]{36})$/.exec(hash)?.[1];
      if(!id)try{id=storage?.getItem(KEY);}catch{}
      if(!UUID.test(id??''))return null;
      const found=phones.find(p=>p.id===id);
      if(!found){clear();return null;}
      return found.state==='running'?found:null;
    }};
}
