import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const REPO_NAME = 'plsql-docagent'  // ← cambia esto por el nombre de tu repo en GitHub

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'serve' ? '/' : `/${REPO_NAME}/`,
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