// The vite import query the worker uses to carry the app's own files
// (theme.ts): `?raw` is a file's text.
declare module "*?raw" {
  const text: string;
  export default text;
}
