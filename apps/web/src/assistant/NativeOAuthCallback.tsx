import {useEffect} from 'react';
import {deliverNativeOAuthReturn,readNativeOAuthReturn} from './native-oauth';
import {nativeText} from './native-copy';
import {browserLocaleStorage,resolveInitialLocale} from '../preferences/locale-preference.mjs';
import type {Locale} from '../i18n';

// Runs before the authenticated app. No API operation happens on this page;
// only the still-authenticated initiating client can finish the native flow.
export function NativeOAuthCallback({response}:{response:ReturnType<typeof readNativeOAuthReturn>}) {
  const locale=resolveInitialLocale({storage:browserLocaleStorage()}) as Locale;
  useEffect(()=>{
    if(!response)return;
    deliverNativeOAuthReturn(response);
    // COOP can detach the opener while visiting the authorization server.
    // The callback closes its own script-opened window after posting; the
    // initiating page must not depend on its old WindowProxy still working.
    window.close();
  },[response]);
  return <main className="auth-shell"><section role="status"><h1>Team AI Box</h1><p>{nativeText(locale,response&&!response.error?'authReturn':'authFailed')}</p></section></main>;
}
