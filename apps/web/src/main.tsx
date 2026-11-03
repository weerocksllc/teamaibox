import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AuthenticatedApp } from "./auth/AuthenticatedApp";
import { NativeOAuthCallback } from './assistant/NativeOAuthCallback';
import { nativeOAuthCallbackPath,readNativeOAuthReturn } from './assistant/native-oauth';
import "@teamaibox/ui-system/tokens.css";
import "@teamaibox/ui-system/primitives.css";
import "./styles.css";
import "./precision.css";
import "../../../packages/ui-system/src/premium-interiors.css";
import "./premium-workspace.css";
import "./focus-workspace.css";

const isNativeOAuthCallback=location.pathname===nativeOAuthCallbackPath;
const nativeOAuthReturn=isNativeOAuthCallback?readNativeOAuthReturn(new URL(location.href)):null;
if(isNativeOAuthCallback)history.replaceState(null,'',location.pathname);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isNativeOAuthCallback?<NativeOAuthCallback response={nativeOAuthReturn}/>:<AuthenticatedApp />}
  </StrictMode>,
);
