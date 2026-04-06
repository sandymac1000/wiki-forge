import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import https from 'https'
import http from 'http'
import { spawn } from 'child_process'
import { writeFileSync, readFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, extname } from 'path'

// ── Paper fetch proxy ────────────────────────────────────────────────────────

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

// ── Document conversion middleware ───────────────────────────────────────────

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    proc.stdout.on('data', d => stdout += d)
    proc.stderr.on('data', d => stderr += d)
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`${cmd} failed (${code}): ${stderr.slice(0, 200)}`))
      else resolve(stdout)
    })
    proc.on('error', e => reject(new Error(`${cmd} not found — ${e.message}`)))
  })
}

async function convertToMarkdown(type, filename, contentBase64, url) {
  if (type === 'text') return contentBase64 // reused field for plain text passthrough

  if (type === 'url') {
    try {
      return await runCmd('markitdown', [url])
    } catch {
      throw new Error('markitdown not installed. Run: pip install "markitdown[all]"')
    }
  }

  if (type === 'file') {
    const ext = extname(filename).toLowerCase()
    const tmp = join(tmpdir(), `wiki-ingest-${Date.now()}${ext}`)
    writeFileSync(tmp, Buffer.from(contentBase64, 'base64'))

    try {
      if (['.md', '.txt'].includes(ext)) {
        return Buffer.from(contentBase64, 'base64').toString('utf-8')
      }

      if (ext === '.pdf') {
        try {
          return await runCmd('python3', [
            '-c',
            'import pymupdf4llm,sys; print(pymupdf4llm.to_markdown(sys.argv[1]))',
            tmp,
          ])
        } catch {
          return await runCmd('markitdown', [tmp])
        }
      }

      if (ext === '.docx') {
        try {
          return await runCmd('pandoc', [tmp, '--wrap=none', '-t', 'gfm'])
        } catch {
          return await runCmd('markitdown', [tmp])
        }
      }

      if (ext === '.pptx') {
        try {
          const outPath = tmp.replace(/\.pptx$/i, '-out.md')
          await runCmd('pptx2md', [tmp, '-o', outPath, '--disable-image'])
          const result = readFileSync(outPath, 'utf-8')
          try { unlinkSync(outPath) } catch {}
          return result
        } catch {
          return await runCmd('markitdown', [tmp])
        }
      }

      // .xlsx, .xls, .html, .htm — markitdown handles all
      return await runCmd('markitdown', [tmp])

    } finally {
      try { unlinkSync(tmp) } catch {}
    }
  }

  throw new Error(`Unknown conversion type: ${type}`)
}

function detectSourceType(ext) {
  const map = {
    '.pdf': 'report', '.docx': 'report', '.doc': 'report',
    '.pptx': 'transcript', '.ppt': 'transcript',
    '.xlsx': 'data', '.xls': 'data', '.csv': 'data',
    '.md': 'notes', '.txt': 'notes',
    '.html': 'article', '.htm': 'article',
  }
  return map[ext] || 'article'
}

function convertPlugin() {
  return {
    name: 'convert',
    configureServer(server) {
      server.middlewares.use('/convert', (req, res) => {
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
          res.end()
          return
        }

        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method not allowed')
          return
        }

        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')

          let payload
          try {
            payload = JSON.parse(body)
          } catch {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'Invalid JSON' }))
            return
          }

          try {
            const markdown = await convertToMarkdown(
              payload.type,
              payload.filename,
              payload.content_base64 || payload.content,
              payload.url,
            )
            const ext = payload.filename ? extname(payload.filename).toLowerCase() : ''
            const detected_type = payload.type === 'url' ? 'article' : detectSourceType(ext)
            res.end(JSON.stringify({ markdown, detected_type }))
          } catch (e) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: e.message }))
          }
        })
      })
    }
  }
}

// ── Vite config ───────────────────────────────────────────────────────────────

export default defineConfig({
  plugins: [react(), paperFetchPlugin(), convertPlugin()],
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
