import type {NativeMessage} from './native-client';

/** Projection of native history only; not a queue or an execution decision. */
export function nativePendingMessages(messages:NativeMessage[]):ReadonlySet<string>{
  const completed=messages.findLastIndex(item=>item.info.role==='assistant'&&item.info.time.completed!==undefined);
  const pending=messages.findLastIndex((item,index)=>index>completed&&item.info.role==='assistant'&&item.info.time.completed===undefined);
  return new Set(pending<0?[]:messages.slice(pending+1).filter(item=>item.info.role==='user').map(item=>item.info.id));
}
