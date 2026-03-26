import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/obsidian': {
        target: 'http://127.0.0.1:27123',
        rewrite: (path) => path.replace(/^\/obsidian/, ''),
        changeOrigin: true,
      },
      '/anthropic': {
        target: 'https://api.anthropic.com',
        rewrite: (path) => path.replace(/^\/anthropic/, ''),
        changeOrigin: true,
        secure: true,
      }
    }
  }
})