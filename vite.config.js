import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import apiProxyPlugin from './vite-plugin-api.js'

const REPO_NAME = 'plsql-docagent'
const { version } = JSON.parse(readFileSync('./package.json', 'utf-8'))

// Vercel sets VERCEL=1 automatically; GitHub Pages needs the repo subpath
const isVercel = !!process.env.VERCEL

export default defineConfig(({ command, mode }) => ({
  // apiProxyPlugin serves /api/proxy directly from Vite (dev + preview), so local testing
  // never needs the Vercel CLI — see vite-plugin-api.js. Vercel deployments are unaffected:
  // it only adds this route when Vite itself is the one serving requests.
  plugins: [react(), apiProxyPlugin()],
  // The GH Pages subpath is baked into the built HTML/asset URLs, so it must only apply to
  // the ACTUAL GH Pages build (`npm run deploy`, which passes --mode gh-pages) — a plain
  // `vite build` (the default 'production' mode) stays at base '/', so `vite preview` (and
  // any other local check of the build output) serves correctly at http://localhost:4173/
  // instead of 404ing/serving the wrong content because the browser requests assets under a
  // prefix nothing is mounted at.
  base: command === 'serve' || isVercel || mode !== 'gh-pages' ? '/' : `/${REPO_NAME}/`,
  // Inject package.json version as a build-time constant (no bundle bloat)
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
        }
      }
    }
  }
}))