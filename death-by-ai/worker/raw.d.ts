/** Vite inlines `?raw` imports as strings at build time. */
declare module '*?raw' {
  const text: string
  export default text
}
