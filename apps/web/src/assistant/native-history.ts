import type {NativeMessage,NativeSession} from './native-client';

// Reverted records remain in native storage until the next prompt. Respect the
// engine's boundary without deleting or rewriting the persisted transcript.
export function visibleNativeMessages(messages:NativeMessage[],revert?:NativeSession['revert']):NativeMessage[] {
  if(!revert)return messages;
  const index=messages.findIndex(message=>message.info.id===revert.messageID);
  if(index<0)return messages;
  const before=messages.slice(0,index);
  if(!revert.partID)return before;
  const message=messages[index],part=message.parts.findIndex(value=>value.id===revert.partID);
  return [...before,{...message,parts:part<0?message.parts:message.parts.slice(0,part)}];
}
