import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AuthenticatedApp } from "./auth/AuthenticatedApp";
import "@teamaibox/ui-system/tokens.css";
import "@teamaibox/ui-system/primitives.css";
import "./styles.css";
import "./precision.css";
import "../../../packages/ui-system/src/premium-interiors.css";
import "./premium-workspace.css";
import "./focus-workspace.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthenticatedApp />
  </StrictMode>,
);
