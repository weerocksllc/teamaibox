import { localizedCatalogs, productText } from "./product-localization.mjs";
// Personal cleanup uses server state, never a local-only hiding flag.
export function installMessageCleanup({ request, locale, current, name, refresh }) {
  const words = localizedCatalogs({
    'zh-CN': { message:'删除这条消息', clear:'清空聊天记录', remove:'删除聊天', cancel:'取消', confirm:'确认',
      messageBody:'仅从你的聊天记录中删除这条消息，其他成员的记录不受影响。',
      clearBody:'清空你在此聊天中已有的记录。其他成员的记录不受影响，之后的新消息仍会显示。',
      removeBody:'从你的列表中删除这条聊天，并清空你已有的聊天记录。不会删除对方的记录，也不会退出群聊；收到新消息后，聊天会重新出现。',
      failed:'操作未完成，请重试。', working:'正在处理…', done:'已更新你的聊天记录。' },
    en: { message:'Delete this message', clear:'Clear chat history', remove:'Delete chat', cancel:'Cancel', confirm:'Confirm',
      messageBody:'Delete this message from your history only. Other members keep their copies.',
      clearBody:'Clear your existing history in this conversation. Other members are unaffected; later messages remain visible.',
      removeBody:'Remove this conversation from your list and clear your history. You remain a member. New messages bring it back.',
      failed:'Unable to complete the action. Please retry.', working:'Working…', done:'Your chat history has been updated.' },
  });
  const t = key => (words[locale()] ?? words['zh-CN'])[key];
  const dialog = document.createElement('dialog'); dialog.className = 'cleanup-dialog';
  const form = document.createElement('form'); form.method = 'dialog';
  const title = document.createElement('h2'); title.id = 'cleanup-title'; dialog.setAttribute('aria-labelledby', title.id);
  const description = document.createElement('p'); description.id='cleanup-description'; dialog.setAttribute('aria-describedby',description.id);
  const error = document.createElement('p'); error.className='composer-error'; error.setAttribute('role','alert');
  const actions = document.createElement('footer');
  const cancel = document.createElement('button'); cancel.type='button';
  const confirm = document.createElement('button'); confirm.type='submit'; confirm.className='cleanup-danger';
  actions.append(cancel,confirm); form.append(title,description,error,actions); dialog.append(form); document.body.append(dialog);
  const notice=document.createElement('p'); notice.className='cleanup-notice'; notice.setAttribute('role','status'); notice.hidden=true;
  document.querySelector('.chat-header').after(notice);
  let target=null, busy=false, opener=null, noticeTimer;
  function open(action,messageId=null,button=null,conversation=current()) {
    if (!conversation) return;
    opener=button; target={conversationId:conversation.id,action,messageId,throughSequence:conversation.lastMessageSequence??conversation.last_message_sequence??0};
    const label=name(conversation);
    title.textContent=action==='remove'?(productText(document.documentElement.lang, "Delete chat “{v0}”?", "删除聊天「{v0}」？", {v0: label})):t(action);
    description.textContent=t(`${action}Body`); error.textContent='';
    cancel.textContent=t('cancel'); confirm.textContent=t(action==='remove'?'remove':'confirm'); confirm.disabled=false;
    dialog.showModal(); cancel.focus();
  }
  cancel.addEventListener('click',()=>{if(!busy)dialog.close()});
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault()});
  dialog.addEventListener('close',()=>{if(opener?.isConnected)opener.focus();else document.querySelector('#conversation-search')?.focus()});
  form.addEventListener('submit',async event=>{
    event.preventDefault(); if(busy||!target)return;
    busy=true; confirm.disabled=true; cancel.disabled=true; confirm.textContent=t('working'); error.textContent='';
    try {
      await request(`/api/v1/messaging/conversations/${target.conversationId}/cleanup`,{method:'POST',body:{...target,confirm:true}});
      await refresh(target); dialog.close(); notice.textContent=t('done'); notice.hidden=false;
      clearTimeout(noticeTimer); noticeTimer=setTimeout(()=>notice.hidden=true,4000);
    } catch (failure) { error.textContent=failure.message||t('failed'); }
    finally { busy=false; confirm.disabled=false; cancel.disabled=false; confirm.textContent=t(target?.action==='remove'?'remove':'confirm'); }
  });
  const section=document.createElement('section'); section.className='details-section cleanup-actions';
  for(const action of ['clear','remove']){
    const button=document.createElement('button'); button.type='button'; button.textContent=t(action); button.disabled=!current();
    button.addEventListener('click',()=>open(action,null,button)); section.append(button);
  }
  document.querySelector('#details-pane').append(section);
  return {
    conversationButton(conversation) {
      const button=document.createElement('button'); button.type='button'; button.className='conversation-delete';
      button.textContent=t('remove'); button.setAttribute('aria-label',`${t('remove')}：${name(conversation)}`);
      // The row, not the currently open chat, is the confirmed deletion target.
      button.addEventListener('click',()=>open('remove',null,button,conversation)); return button;
    },
    messageButton(message) {
      const button=document.createElement('button'); button.type='button'; button.className='message-cleanup';
      button.textContent=t('message'); button.addEventListener('click',()=>open('message',message.id,button)); return button;
    },
    update() { [...section.children].forEach((button,index)=>{button.textContent=t(index?'remove':'clear');button.disabled=!current()}); },
  };
}
