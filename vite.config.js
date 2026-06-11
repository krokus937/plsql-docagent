import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const REPO_NAME = 'plsql-docagent'

// Vercel sets VERCEL=1 automatically; GitHub Pages needs the repo subpath
const isVercel = !!process.env.VERCEL

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'serve' || isVercel ? '/' : `/${REPO_NAME}/`,
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