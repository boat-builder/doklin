// The two vite import queries the worker uses to carry the app's own files
// (theme.ts): `?raw` is a file's text, `?inline` a binary file as a data: URL.
declare module "*?raw" {
  const text: string;
  export default text;
}

declare module "*?inline" {
  const dataUrl: string;
  export default dataUrl;
}
