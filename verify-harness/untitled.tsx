// Mounts the REAL App (same StrictMode wrapper as src/main.tsx) on top of
// the IPC stub in untitled.html — drive-untitled.mjs walks an untitled note
// from ⌘N through typing, closing, saving and a relaunch.
import React from "react";
import ReactDOM from "react-dom/client";
import App from "../src/App";
import "../src/App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
