import {createContext,useContext} from 'react';
import type {Locale} from '../i18n';
import type {NativeClient} from './native-client';
export type RichMessageContextValue={client:NativeClient;directory:string;scopeKey:string;locale:Locale};
export const RichMessageContext=createContext<RichMessageContextValue|null>(null);
export function useRichMessageContext(){const value=useContext(RichMessageContext);if(!value)throw Error('Rich message context missing');return value;}
