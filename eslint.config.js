// Deliberately minimal: this exists to enforce React's rules of hooks, which
// tsc cannot check (a useEffect below an early return shipped in v0.1.24 and
// made the app unbootable for four releases). Not a style regime.
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["dist/**"] },
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // Advisory only (warnings don't fail CI): deliberately partial dep
      // arrays are an established pattern here — suppress intentional ones
      // with a documented eslint-disable-next-line, as existing code does.
      "react-hooks/exhaustive-deps": "warn",
      // The frontend never fetches: the cloud engine in Rust is the only code
      // that holds a token or talks to a domain.
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "The frontend never fetches: ask src/backend.ts for it." },
      ],
    },
  },
  // The UI is written against src/backend.ts; only the Mac's answer to it
  // knows that Tauri is underneath.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/mac/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@tauri-apps/**"], message: "Only src/mac/ imports Tauri: ask src/backend.ts for it." },
          ],
        },
      ],
    },
  },
];
