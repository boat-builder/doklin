// Mounts the REAL App (same StrictMode wrapper as src/main.tsx) on top of
// the IPC stub in meta.html — the entity-meta drive walks migration,
// expansion, body-only saves, orphans, and reload persistence.
import React from "react";
import ReactDOM from "react-dom/client";
import App from "../src/App";
import "../src/App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
