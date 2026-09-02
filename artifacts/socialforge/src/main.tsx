import { createRoot } from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./components/app-error-boundary";
import "./index.css";

const previewBootstrapVersion = "kokao-preview-bootstrap-2026-09-02-2";
let shouldRender = true;

if (import.meta.hot) {
  try {
    if (sessionStorage.getItem("kokao-preview-bootstrap-version") !== previewBootstrapVersion) {
      sessionStorage.setItem("kokao-preview-bootstrap-version", previewBootstrapVersion);
      shouldRender = false;
      window.location.reload();
    }
  } catch {
    // Storage can be unavailable in hardened browser contexts; render normally.
  }
}

if (shouldRender) {
  createRoot(document.getElementById("root")!).render(
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>,
  );
}
