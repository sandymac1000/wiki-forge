import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import https from 'https'
import http from 'http'

function paperFetchPlugin() {
  return {
    name: 'paper-fetch',
    configureServer(server) {
      server.middlewares.use('/paperfetch', (req, res) => {
        const urlMatch = req.url?.match(/[?&]?url=([^&]+)/)
        if (!urlMatch) {
          res.statusCode = 400
          res.end('Missing url param')
          return
        }
        const targetUrl = decodeURIComponent(urlMatch[1])
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
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), paperFetchPlugin()],
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
    }
  }
})
