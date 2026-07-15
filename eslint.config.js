// Deliberately minimal: this exists to enforce React's rules of hooks, which
// tsc cannot check (a useEffect below an early return shipped in v0.1.24 and
// made the app unbootable for four releases). Not a style regime.
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  // Build outputs (the compiled web shell lands in share-worker/dist and
  // carries its dependencies' inline eslint pragmas).
  { ignores: ["dist/**", "share-worker/dist/**"] },
  {
    files: ["src/**/*.ts", "src/**/*.tsx", "web/**/*.ts", "web/**/*.tsx"],
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
    },
  },
];
