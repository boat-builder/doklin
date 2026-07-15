// Entry point of the shared page's app shell. The worker's shell page for
// comment/edit sessions carries a boot record in #dk-boot and a #dk-root to
// mount into; this bundle (built by scripts/build-web.mjs, embedded in the
// worker) does the rest with the SAME components the desktop app renders.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import WebApp, { type Boot } from "./WebApp";

// The full desktop stylesheet: themes (light/dark/sepia via [data-theme] with
// a prefers-color-scheme default), the editor canvas, the comment rail — one
// look on both sides is the whole point.
import "../src/App.css";
import "./web.css";

function readBoot(): Boot | null {
  const el = document.getElementById("dk-boot");
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as Boot;
  } catch {
    return null;
  }
}

const boot = readBoot();
const root = document.getElementById("dk-root");
if (boot && root) {
  createRoot(root).render(
    <StrictMode>
      <WebApp boot={boot} />
    </StrictMode>,
  );
} else {
  document.body.textContent = "This page didn't load correctly — refresh to retry.";
}
