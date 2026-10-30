// Tickets stay in page memory except an explicit copy. Commands contain only
// public origin/identifiers, never a ticket or login cookie.
export function createPhoneDebug({element,api,translate,getPhoneId}) {
  const find=id=>element.querySelector(`#${id}`);
  let phoneId=null,grant=null,busy=false,epoch=0,timer=null,message='debugOff';
  function clearSecret(){find('phone-adb-token').value='';find('phone-adb-secret').hidden=true;}
  function render(){
    const live=grant && Date.parse(grant.expiresAt)>Date.now();
    find('phone-adb-enable').disabled=busy||Boolean(live)||!phoneId;
    find('phone-adb-disable').hidden=!grant;find('phone-adb-disable').disabled=busy;
    find('phone-adb-issued').hidden=!live;
    find('phone-adb-status').textContent=translate(message,{time:grant?new Date(grant.expiresAt).toLocaleTimeString(document.documentElement.lang):''});
    if(grant && Date.now()>=Date.parse(grant.connectionExpiresAt)){clearSecret();find('phone-adb-code-expired').hidden=false;}
  }
  function wipe(){clearTimeout(timer);timer=null;grant=null;clearSecret();find('phone-adb-command').textContent='';find('phone-adb-code-expired').hidden=true;}
  function tick(){
    if(!grant)return;
    if(Date.now()>=Date.parse(grant.expiresAt)){wipe();message='debugExpired';}
    render();if(grant)timer=setTimeout(tick,1000);
  }
  async function revoke(value){if(value)await api.disableDebug(value.phoneId,value.id);}
  function reset(){
    ++epoch;const old=grant;wipe();phoneId=null;busy=false;message='debugOff';element.close();
    // Page exit is best-effort. Absolute expiry and login revocation remain
    // authoritative if this request cannot reach the server.
    void revoke(old).catch(()=>{});render();
  }
  function open(){
    const id=getPhoneId();if(!id)return;
    if(phoneId!==id){reset();phoneId=id;}
    render();element.showModal();
  }
  find('phone-adb-enable').addEventListener('click',()=>{
    if(busy||grant||!phoneId)return;busy=true;message='debugEnabling';render();const current=epoch,id=phoneId;
    void api.enableDebug(id).then(async value=>{
      if(current!==epoch){await revoke(value);return;}
      grant={id:value.id,phoneId:value.phoneId,expiresAt:value.expiresAt,connectionExpiresAt:value.connectionExpiresAt};
      find('phone-adb-token').value=value.token;value.token=null;find('phone-adb-secret').hidden=false;
      find('phone-adb-command').textContent=`node --use-system-ca phone-adb-cli.mjs --origin=${JSON.stringify(location.origin)} --phone=${grant.phoneId} --grant=${grant.id}`;
      message='debugAuthorized';tick();
    }).catch(()=>{if(current===epoch){clearSecret();message='debugEnableFailed';}})
      .finally(()=>{if(current===epoch){busy=false;render();}});
  });
  find('phone-adb-disable').addEventListener('click',()=>{
    if(busy||!grant)return;busy=true;clearSecret();message='debugClosing';render();const current=epoch;
    void revoke(grant).then(()=>{if(current===epoch){wipe();message='debugOff';}})
      .catch(()=>{if(current===epoch)message='debugCloseFailed';})
      .finally(()=>{if(current===epoch){busy=false;render();}});
  });
  find('phone-adb-copy').addEventListener('click',()=>{
    if(!grant||Date.now()>=Date.parse(grant.connectionExpiresAt)){clearSecret();return;}
    const fallback=()=>{find('phone-adb-token').focus();find('phone-adb-token').select();};
    if(navigator.clipboard)void navigator.clipboard.writeText(find('phone-adb-token').value).catch(fallback);else fallback();
  });
  find('phone-adb-dismiss').addEventListener('click',()=>element.close());
  window.addEventListener('pagehide',reset);
  return {open,reset,translate:render};
}
