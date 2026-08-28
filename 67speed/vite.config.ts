import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The vendored .task model and .wasm fileset are served as-is from /public;
    // nothing here should ever be inlined or rewritten.
    assetsInlineLimit: 0,
  },
})
