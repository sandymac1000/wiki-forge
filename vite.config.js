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
      },
      '/paperfetch': {
        target: 'https://placeholder.invalid',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => {
          // path is /paperfetch?url=https://...
          // The router below handles this via bypass
          return path
        },
        bypass(req, res) {
          const raw = req.url || ''
          const match = raw.match(/[?&]url=([^&]+)/)
          if (!match) {
            res.statusCode = 400
            res.end('Missing url param')
            return false
          }
          const targetUrl = decodeURIComponent(match[1])
          const https = require('https')
          const http = require('http')
          const client = targetUrl.startsWith('https') ? https : http
          const reqOut = client.get(targetUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; PromptForge/1.0)',
              'Accept': 'text/html,application/xhtml+xml,*/*',
            }
          }, (upstream) => {
            res.statusCode = upstream.statusCode
            res.setHeader('Content-Type', upstream.headers['content-type'] || 'text/html')
            res.setHeader('Access-Control-Allow-Origin', '*')
            upstream.pipe(res)
          })
          reqOut.on('error', (e) => {
            res.statusCode = 502
            res.end(`Fetch error: ${e.message}`)
          })
          return false
        }
      }
    }
  }
})