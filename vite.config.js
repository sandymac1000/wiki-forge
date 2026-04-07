import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import https from 'https'
import http from 'http'
import { spawn } from 'child_process'
import { writeFileSync, readFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, extname } from 'path'
import TurndownService from 'turndown'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const pdfParse = require('pdf-parse')
const AdmZip = require('adm-zip')

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
            'User-Agent': 'Mozilla/5.0 (compatible; WikiForge/1.0)',
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

async function runMarkitdown(path) {
  // Try markitdown CLI (requires pip install markitdown[all] with a working version)
  try { return await runCmd('markitdown', [path]) } catch {}
  // Try python3 -m markitdown
  try { return await runCmd('python3', ['-m', 'markitdown', path]) } catch {}
  throw new Error('No document converter available — install markitdown: pip install markitdown[all]')
}

function extractDocxText(buffer) {
  const zip = new AdmZip(buffer)
  const entry = zip.getEntry('word/document.xml')
  if (!entry) throw new Error('word/document.xml not found in DOCX')
  const xml = entry.getData().toString('utf-8')

  // Each <w:p> is a paragraph; text is in <w:t> runs
  const paragraphs = []
  const paraRe = /<w:p[ >][\s\S]*?<\/w:p>/g
  let paraMatch
  while ((paraMatch = paraRe.exec(xml)) !== null) {
    const paraXml = paraMatch[0]
    // Check if paragraph is a heading style
    const styleMatch = paraXml.match(/<w:pStyle w:val="([^"]+)"/)
    const style = styleMatch ? styleMatch[1].toLowerCase() : ''
    const texts = []
    const runRe = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
    let runMatch
    while ((runMatch = runRe.exec(paraXml)) !== null) {
      const t = runMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
      if (t) texts.push(t)
    }
    const line = texts.join('')
    if (!line) continue
    if (style.startsWith('heading') || style === 'title') {
      const level = style.replace('heading', '') || '1'
      paragraphs.push(`${'#'.repeat(Math.min(parseInt(level) || 1, 4))} ${line}`)
    } else {
      paragraphs.push(line)
    }
  }
  return paragraphs.join('\n\n')
}

function extractXlsxText(buffer) {
  const zip = new AdmZip(buffer)

  // Load shared strings table
  const ssEntry = zip.getEntry('xl/sharedStrings.xml')
  const sharedStrings = []
  if (ssEntry) {
    const ssXml = ssEntry.getData().toString('utf-8')
    const siRe = /<si>([\s\S]*?)<\/si>/g
    let m
    while ((m = siRe.exec(ssXml)) !== null) {
      const texts = []
      const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g
      let t
      while ((t = tRe.exec(m[1])) !== null) texts.push(t[1])
      sharedStrings.push(texts.join('').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
    }
  }

  // Extract each sheet
  const sheets = zip.getEntries()
    .filter(e => e.entryName.match(/^xl\/worksheets\/sheet\d+\.xml$/))
    .sort((a, b) => a.entryName.localeCompare(b.entryName))

  return sheets.map((sheetEntry, si) => {
    const xml = sheetEntry.getData().toString('utf-8')
    const rows = {}
    const cellRe = /<c r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>/g
    let m
    while ((m = cellRe.exec(xml)) !== null) {
      const col = m[1], row = parseInt(m[2]), attrs = m[3], inner = m[4]
      const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/)
      if (!vMatch) continue
      const isStr = /t="s"/.test(attrs)
      const val = isStr ? (sharedStrings[parseInt(vMatch[1])] ?? '') : vMatch[1]
      if (!rows[row]) rows[row] = {}
      rows[row][col] = val
    }
    const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b)
    const lines = rowNums.map(r => {
      const cols = Object.keys(rows[r]).sort()
      return cols.map(c => rows[r][c]).join('\t')
    })
    return `### Sheet ${si + 1}\n\n${lines.join('\n')}`
  }).join('\n\n---\n\n')
}

function extractPptxText(buffer) {
  const zip = new AdmZip(buffer)
  const entries = zip.getEntries()
    .filter(e => e.entryName.match(/^ppt\/slides\/slide\d+\.xml$/))
    .sort((a, b) => {
      const na = parseInt(a.entryName.match(/(\d+)/)[1])
      const nb = parseInt(b.entryName.match(/(\d+)/)[1])
      return na - nb
    })

  if (entries.length === 0) throw new Error('No slides found in PPTX')

  const slides = entries.map((entry, i) => {
    const xml = entry.getData().toString('utf-8')
    // Extract text runs from DrawingML: <a:t>text</a:t>
    const texts = []
    let match
    const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g
    while ((match = re.exec(xml)) !== null) {
      const t = match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()
      if (t) texts.push(t)
    }
    if (texts.length === 0) return null
    // First text block on slide is usually the title
    const [title, ...body] = texts
    return `## Slide ${i + 1}: ${title}\n\n${body.join('\n')}`
  }).filter(Boolean)

  return slides.join('\n\n---\n\n')
}

async function convertToMarkdown(type, filename, contentBase64, url) {
  if (type === 'text') return contentBase64 // reused field for plain text passthrough

  if (type === 'url') {
    // Twitter/X: use oEmbed to get actual tweet content
    if (/^https?:\/\/(twitter\.com|x\.com)\//.test(url)) {
      const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`
      const oRes = await fetch(oembedUrl)
      if (oRes.ok) {
        const oData = await oRes.json()
        const td = new TurndownService({ headingStyle: 'atx' })
        const text = td.turndown(oData.html || '')
        return `**Tweet by ${oData.author_name}**\n\n${text}\n\n[View original](${url})`
      }
    }

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      }
    })
    if (!res.ok) throw new Error(`Failed to fetch URL: ${res.status}`)
    let html = await res.text()

    // Strip elements that produce noise in markdown conversion
    html = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')

    // Extract body content only if available
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
    const content = bodyMatch ? bodyMatch[1] : html

    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    td.remove(['head', 'nav', 'footer', 'aside', 'iframe'])
    return td.turndown(content)
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
          const pdfBuffer = Buffer.from(contentBase64, 'base64')
          console.log('[pdf-parse] pdfParse type:', typeof pdfParse)
          const data = await pdfParse(pdfBuffer)
          return data.text
        } catch (e) {
          console.error('[pdf-parse] failed:', e.message)
          return await runMarkitdown(tmp)
        }
      }

      if (ext === '.docx') {
        try {
          const docxBuffer = Buffer.from(contentBase64, 'base64')
          return extractDocxText(docxBuffer)
        } catch (e) {
          console.error('[docx] Node extraction failed:', e.message)
          try { return await runCmd('pandoc', [tmp, '--wrap=none', '-t', 'gfm']) } catch {}
          return await runMarkitdown(tmp)
        }
      }

      if (ext === '.pptx') {
        try {
          const pptxBuffer = Buffer.from(contentBase64, 'base64')
          return extractPptxText(pptxBuffer)
        } catch (e) {
          console.error('[pptx] Node extraction failed:', e.message)
          return await runMarkitdown(tmp)
        }
      }

      if (['.xlsx', '.xls'].includes(ext)) {
        try {
          const xlsxBuffer = Buffer.from(contentBase64, 'base64')
          return extractXlsxText(xlsxBuffer)
        } catch (e) {
          console.error('[xlsx] Node extraction failed:', e.message)
          return await runMarkitdown(tmp)
        }
      }

      // .html, .htm — markitdown handles, or fall through
      return await runMarkitdown(tmp)

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
