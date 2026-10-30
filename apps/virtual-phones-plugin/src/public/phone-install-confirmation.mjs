// Native confirm() is unavailable in the application iframe sandbox.
// This page-local confirmation needs no additional browser permissions.
export function confirmPhoneInstallation(element,file,signal) {
  signal.throwIfAborted();
  const find=id=>element.querySelector('#'+id),panel=find('phone-install-confirmation');
  const yes=find('phone-install-yes'),no=find('phone-install-no');
  find('phone-install-name').textContent=file.name;panel.hidden=false;no.focus();
  return new Promise((resolve,reject)=>{
    const finish=(accepted,error)=>{
      panel.hidden=true;find('phone-install-name').textContent='';
      yes.removeEventListener('click',accept);no.removeEventListener('click',decline);
      signal.removeEventListener('abort',abort);
      if(error)reject(error);else resolve(accepted);
    };
    const accept=()=>finish(true),decline=()=>finish(false),abort=()=>finish(false,signal.reason);
    yes.addEventListener('click',accept);no.addEventListener('click',decline);signal.addEventListener('abort',abort,{once:true});
  });
}
