// Mounts the REAL App (same StrictMode wrapper as src/main.tsx) on top of
// the IPC stub in cloud.html — the cloud drive walks the actual panel,
// wizard, update card, history panel, toasts and sidebar chips against a
// scripted fake of the engine.
import React from "react";
import ReactDOM from "react-dom/client";
import App from "../src/App";
import "../src/App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
