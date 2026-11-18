// Mounts the REAL App (same StrictMode wrapper as src/main.tsx) on top of
// the IPC stub in split.html — the split-view drive walks actual tabs,
// panes, promotion, autosave, and scroll sync.
import React from "react";
import ReactDOM from "react-dom/client";
import App from "../src/App";
import "../src/App.css";
import { installBackend } from "../src/backend";
import { macBackend } from "../src/mac/backend";

// The Mac's backend, answered by the page's IPC stub.
installBackend(macBackend);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
