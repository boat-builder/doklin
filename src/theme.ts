// The theme (Settings → Appearance). Out of App.tsx so that a screen
// shown before the app is (the browser version's sign-in) wears it too.

export type Theme = "system" | "light" | "paper" | "dark";
export const THEMES: Theme[] = ["system", "light", "paper", "dark"];
export const THEME_STORAGE_KEY = "doklin:theme";

export function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v && (THEMES as string[]).includes(v)) return v as Theme;
  } catch {
    // localStorage may be unavailable; fall through
  }
  return "system";
}

// The theme that actually paints: "system" resolves here, once, against the
// OS appearance. <html data-theme> only ever carries a resolved name, so
// tokens.css writes each palette exactly once — no prefers-color-scheme
// copies to drift — and an OS flip is the same attribute change as a menu
// pick. The stored choice rides along on data-theme-pref for anything that
// needs it.
export type ResolvedTheme = Exclude<Theme, "system">;
export const darkSchemeQuery =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

function resolveTheme(t: Theme): ResolvedTheme {
  if (t !== "system") return t;
  return darkSchemeQuery?.matches ? "dark" : "light";
}

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  const resolved = resolveTheme(t);
  if (root.dataset.theme !== resolved) root.dataset.theme = resolved;
  root.dataset.themePref = t;
}
