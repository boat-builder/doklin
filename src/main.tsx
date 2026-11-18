import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { installBackend } from "./backend";
import { macBackend } from "./mac/backend";

// The Mac app: the UI, on the backend that answers through Tauri.
installBackend(macBackend);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
