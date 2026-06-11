import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'

const REPO_NAME = 'plsql-docagent'
const { version } = JSON.parse(readFileSync('./package.json', 'utf-8'))

// Vercel sets VERCEL=1 automatically; GitHub Pages needs the repo subpath
const isVercel = !!process.env.VERCEL

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'serve' || isVercel ? '/' : `/${REPO_NAME}/`,
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