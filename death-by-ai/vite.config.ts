import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// `npm run dev:offline` skips the Workers AI connection (Clef), so the game runs
// with no Cloudflare login. Use the mock models in .dev.vars for that.
export default defineConfig(({ mode }) => ({
  plugins: [react(), cloudflare({ remoteBindings: mode !== 'offline' })],
}))
