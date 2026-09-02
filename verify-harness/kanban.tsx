// Mounts the REAL App (same StrictMode wrapper as src/main.tsx) on top of the
// IPC stub in kanban.html — the datastore drive walks the actual sidebar
// board row, board tab, drag, inline composers, and properties header.
import React from "react";
import ReactDOM from "react-dom/client";
import App from "../src/App";
import "../src/App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
