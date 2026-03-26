import { useState, useEffect, useRef } from 'react'
import { listVault, readFile, updateFrontmatter, parseFrontmatter, stripFrontmatter } from '../lib/obsidian.js'
import { runPrompt } from '../lib/anthropic.js'

const TEMP_PRESETS = [
  { label: 'precise',  value: 0.2, desc: 'factual, low variance' },
  { label: 'balanced', value: 0.5, desc: 'default' },
  { label: 'creative', value: 0.8, desc: 'generative, exploratory' },
  { label: 'wild',     value: 1.0, desc: 'max variance' },
]

// ── Paper fetch helpers ──────────────────────────────────────────────────────

function extractArxivId(url) {
  const m = url.match(/arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}(?:v\d+)?)/)
  return m ? m[1] : null
}

function extractBiorxivDoi(url) {
  const m = url.match(/biorxiv\.org\/content\/(10\.\d{4,}\/[^\s?#]+)/)
  return m ? m[1] : null
}

function extractPubmedId(url) {
  const m = url.match(/(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pubmed)\/(\d+)/)
  return m ? m[1] : null
}

function htmlToText(html) {
  // Remove script/style blocks
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
  // Convert block elements to newlines
  text = text
    .replace(/<\/?(p|div|section|article|h[1-6]|li|br)[^>]*>/gi, '\n')
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '')
  // Decode common entities
  text = text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  // Collapse whitespace
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim()
  // Truncate to ~6000 words to keep within context
  const words = text.split(/\s+/)
  if (words.length > 6000) {
    text = words.slice(0, 6000).join(' ') + '\n\n[truncated — full paper exceeds context limit]'
  }
  return text
}

async function fetchPaper(url) {
  url = url.trim()

  // arXiv — fetch HTML version directly (CORS permissive)
  const arxivId = extractArxivId(url)
  if (arxivId) {
    const htmlUrl = `https://arxiv.org/html/${arxivId}`
    try {
      const res = await fetch(`/paperfetch?url=${encodeURIComponent(htmlUrl)}`)
      if (res.ok) {
        const html = await res.text()
        const text = htmlToText(html)
        if (text.length > 200) return { text, source: `arXiv:${arxivId}`, url: htmlUrl }
      }
    } catch {}
    // Fallback: abstract only
    const absUrl = `https://arxiv.org/abs/${arxivId}`
    const res2 = await fetch(`/paperfetch?url=${encodeURIComponent(absUrl)}`)
    if (res2.ok) {
      const html = await res2.text()
      const text = htmlToText(html)
      return { text, source: `arXiv:${arxivId} (abstract)`, url: absUrl }
    }
    throw new Error('arXiv fetch failed — try pasting the abstract text directly')
  }

  // bioRxiv
  const biorxivDoi = extractBiorxivDoi(url)
  if (biorxivDoi) {
    const fetchUrl = `https://www.biorxiv.org/content/${biorxivDoi}v1`
    const res = await fetch(`/paperfetch?url=${encodeURIComponent(fetchUrl)}`)
    if (res.ok) {
      const html = await res.text()
      const text = htmlToText(html)
      return { text, source: `bioRxiv:${biorxivDoi}`, url: fetchUrl }
    }
    throw new Error('bioRxiv fetch failed — try pasting the abstract text directly')
  }

  // PubMed — abstract only via API
  const pmid = extractPubmedId(url)
  if (pmid) {
    const apiUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&rettype=abstract&retmode=text`
    const res = await fetch(`/paperfetch?url=${encodeURIComponent(apiUrl)}`)
    if (res.ok) {
      const text = await res.text()
      return { text, source: `PubMed:${pmid}`, url }
    }
    throw new Error('PubMed fetch failed — try pasting the abstract text directly')
  }

  // Generic URL — best effort
  const res = await fetch(`/paperfetch?url=${encodeURIComponent(url)}`)
  if (res.ok) {
    const html = await res.text()
    const text = htmlToText(html)
    if (text.length < 100) throw new Error('Page content too short — try pasting text directly')
    return { text, source: url, url }
  }
  throw new Error('Could not fetch URL — try pasting the text directly')
}

// ── Context injection ────────────────────────────────────────────────────────

function buildContext(contextFields) {
  return Object.entries(contextFields)
    .filter(([, v]) => v.trim())
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

// ── Sub-components ───────────────────────────────────────────────────────────

function CopyPromptButton({ promptContent, contextFields, paperText }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      let context = ''
      try {
        const sandy = await readFile('prompts/_context/sandy.md')
        context += `## About the user\n${stripFrontmatter(sandy).trim()}\n\n`
      } catch {}
      try {
        const personas = await readFile('prompts/_context/personas.md')
        context += `## Available personas\n${stripFrontmatter(personas).trim()}\n\n`
      } catch {}

      const userContext = buildContext(contextFields)
      const full = [
        context,
        '---\n',
        '## Prompt\n',
        promptContent,
        paperText ? `\n## Paper / Document\n${paperText}` : '',
        userContext ? `\n## Context\n${userContext}` : '',
      ].filter(Boolean).join('\n')

      await navigator.clipboard.writeText(full)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      console.error('Copy failed', e)
    }
  }

  if (!promptContent) return null

  return (
    <button onClick={handleCopy} style={{
      marginTop: '8px', width: '100%',
      background: copied ? 'var(--forge-green)' : 'var(--forge-surface)',
      border: `1px solid ${copied ? 'var(--forge-green)' : 'var(--forge-border)'}`,
      color: copied ? '#000' : 'var(--forge-muted)',
      fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem',
      padding: '7px', cursor: 'pointer', borderRadius: '4px', transition: 'all 0.2s',
    }}>
      {copied ? '✓ copied — paste into Claude.ai to attach PDFs' : '⎘ copy full prompt'}
    </button>
  )
}

function PaperFetcher({ onFetched, onClear, paperMeta }) {
  const [url, setUrl] = useState('')
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState(null)

  const handleFetch = async () => {
    if (!url.trim()) return
    setFetching(true)
    setFetchError(null)
    try {
      const result = await fetchPaper(url)
      onFetched(result)
      setUrl('')
    } catch (e) {
      setFetchError(e.message)
    }
    setFetching(false)
  }

  if (paperMeta) {
    return (
      <div style={{
        background: 'color-mix(in srgb, var(--forge-green) 8%, var(--forge-surface))',
        border: '1px solid color-mix(in srgb, var(--forge-green) 25%, transparent)',
        borderRadius: '4px', padding: '8px 10px',
        display: 'flex', alignItems: 'flex-start', gap: '8px',
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem', color: 'var(--forge-green)', marginBottom: '2px' }}>✓ paper loaded</div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem', color: 'var(--forge-muted)', wordBreak: 'break-all' }}>{paperMeta.source}</div>
        </div>
        <button onClick={onClear} style={{
          background: 'none', border: '1px solid var(--forge-border)', color: 'var(--forge-muted)',
          fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
          padding: '2px 6px', cursor: 'pointer', borderRadius: '3px', whiteSpace: 'nowrap',
        }}>✕ clear</button>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: '4px' }}>
        <input
          value={url}
          onChange={e => { setUrl(e.target.value); setFetchError(null) }}
          onKeyDown={e => e.key === 'Enter' && handleFetch()}
          placeholder="arxiv.org/abs/… or biorxiv.org/…"
          style={{
            flex: 1, background: 'var(--forge-surface)', border: '1px solid var(--forge-border)',
            color: 'var(--forge-text)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.68rem',
            padding: '5px 8px', borderRadius: '4px', outline: 'none',
          }}
        />
        <button
          onClick={handleFetch}
          disabled={!url.trim() || fetching}
          style={{
            background: fetching ? 'var(--forge-surface)' : 'var(--forge-accent)',
            border: 'none', color: fetching ? 'var(--forge-muted)' : '#000',
            fontFamily: 'JetBrains Mono, monospace', fontSize: '0.68rem', fontWeight: 600,
            padding: '5px 10px', cursor: !url.trim() || fetching ? 'default' : 'pointer',
            borderRadius: '4px', whiteSpace: 'nowrap',
          }}
        >{fetching ? '◌' : '↓ fetch'}</button>
      </div>
      {fetchError && (
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem', color: 'var(--forge-red)', marginTop: '4px', lineHeight: 1.5 }}>
          {fetchError}
        </div>
      )}
    </div>
  )
}

function ContextForm({ params, contextFields, setContextFields }) {
  if (!params) {
    return (
      <textarea
        value={contextFields.freetext || ''}
        onChange={e => setContextFields({ freetext: e.target.value })}
        placeholder="Context for this run…"
        style={{ ...fieldStyle, height: '80px', resize: 'vertical' }}
      />
    )
  }
  const fields = params.split(',').map(f => f.trim()).filter(Boolean)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {fields.map(key => (
        <input
          key={key}
          value={contextFields[key] || ''}
          placeholder={key}
          onChange={e => setContextFields(f => ({ ...f, [key]: e.target.value }))}
          style={fieldStyle}
        />
      ))}
    </div>
  )
}

const fieldStyle = {
  width: '100%', background: 'var(--forge-surface)',
  border: '1px solid var(--forge-border)', color: 'var(--forge-text)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem',
  padding: '6px 8px', borderRadius: '4px', outline: 'none', lineHeight: 1.6,
}

function Label({ children }) {
  return (
    <div style={{
      fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
      color: 'var(--forge-muted)', textTransform: 'uppercase',
      letterSpacing: '0.1em', marginBottom: '4px',
    }}>{children}</div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export function Runner({ navigateTo, navState }) {
  const [templates, setTemplates] = useState([])
  const [selected, setSelected] = useState(null)
  const [promptContent, setPromptContent] = useState('')
  const [frontmatter, setFrontmatter] = useState({})
  const [temperature, setTemperature] = useState(0.5)
  const [contextFields, setContextFields] = useState({})
  const [paperMeta, setPaperMeta] = useState(null)   // { text, source, url }
  const [output, setOutput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [rating, setRating] = useState(null)
  const [note, setNote] = useState('')
  const [saved, setSaved] = useState(false)
  const outputRef = useRef(null)

  // Load all templates (base prompts + variants)
  useEffect(() => {
    async function loadTemplates() {
      const walk = async (path) => {
        const items = await listVault(path)
        const allFiles = items.files || []
        const files = allFiles
          .filter(f => !f.endsWith('/') && f.endsWith('.md'))
          .map(f => path + f)
        const folders = allFiles.filter(f => f.endsWith('/')).map(f => f.slice(0, -1))
        const nested = await Promise.all(folders.map(folder => walk(path + folder + '/')))
        return [...files, ...nested.flat()]
      }
      const all = await walk('prompts/')
      const filtered = all.filter(p => !p.includes('/_context/') && !p.includes('/_archive/'))
      const withLabels = await Promise.all(filtered.map(async p => {
        if (p.includes('/_variants/')) {
          try {
            const raw = await readFile(p)
            const fm = parseFrontmatter(raw)
            const parts = p.replace('prompts/_variants/', '').replace('.md', '').split('/')
            return { path: p, label: `${parts[0]} / ${fm.label || parts[1]}`, isVariant: true }
          } catch { return { path: p, label: p.replace('prompts/', ''), isVariant: true } }
        }
        try {
          const raw = await readFile(p)
          const fm = parseFrontmatter(raw)
          return { path: p, label: fm.title || p.replace('prompts/', '').replace('.md',''), isVariant: false }
        } catch { return { path: p, label: p.replace('prompts/', ''), isVariant: false } }
      }))
      setTemplates(withLabels)
    }
    loadTemplates().catch(console.error)
  }, [])

  // Auto-select from Variants navigation
  useEffect(() => {
    if (navState?.promptPath && templates.length > 0) {
      handleSelect(navState.promptPath)
    }
  }, [navState, templates])

  const handleSelect = async (path) => {
    setSelected(path)
    setOutput('')
    setRating(null)
    setNote('')
    setSaved(false)
    setContextFields({})
    setPaperMeta(null)
    const raw = await readFile(path)
    const fm = parseFrontmatter(raw)
    setFrontmatter(fm)
    setPromptContent(stripFrontmatter(raw))
  }

  const handleRun = async () => {
    if (!selected || streaming) return
    setOutput('')
    setStreaming(true)
    setSaved(false)
    setRating(null)

    try {
      let context = ''
      try {
        const sandy = await readFile('prompts/_context/sandy.md')
        context += `## About the user\n${stripFrontmatter(sandy).trim()}\n\n`
      } catch {}
      try {
        const personas = await readFile('prompts/_context/personas.md')
        context += `## Available personas\n${stripFrontmatter(personas).trim()}\n\n`
      } catch {}

      const systemPrompt = context
        ? `${context}---\n\n## Prompt\n${promptContent}`
        : promptContent

      // Build user message — paper content + params
      const parts = []
      if (paperMeta?.text) {
        parts.push(`## Paper / Document\nSource: ${paperMeta.source}\n\n${paperMeta.text}`)
      }
      const userContext = buildContext(contextFields)
      if (userContext) parts.push(`## Context\n${userContext}`)

        const needsMaterials = !paperMeta && (
          promptContent.toLowerCase().includes('paper') ||
          promptContent.toLowerCase().includes('document') ||
          promptContent.toLowerCase().includes('material') ||
          promptContent.toLowerCase().includes('report') ||
          promptContent.toLowerCase().includes('pdf')
        )

        const userMsg = parts.length > 0
          ? parts.join('\n\n')
          : needsMaterials
            ? '---\nNOTE: No document has been provided. Before proceeding, ask the user to share the paper, report or materials needed to complete this task. Do not attempt to answer without them.\n---'
            : 'Begin.'

      await runPrompt({
        system: systemPrompt,
        user: userMsg,
        temperature,
        onChunk: (chunk, full) => {
          setOutput(full)
          if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
        }
      })
    } catch (e) {
      setOutput(`Error: ${e.message}`)
    }
    setStreaming(false)
  }

  const handleSaveRating = async () => {
    if (!selected || rating === null) return
    await updateFrontmatter(selected, {
      rating,
      last_used: new Date().toISOString().split('T')[0],
      notes: `"${note}"`,
    })
    setSaved(true)
  }

  const params = frontmatter.params || null
  const isVariant = selected?.includes('/_variants/')

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 52px)', overflow: 'hidden' }}>

      {/* Left panel */}
      <div style={{ width: '300px', minWidth: '300px', borderRight: '1px solid var(--forge-border)', overflow: 'auto', padding: '16px' }}>

        <Label>prompt</Label>
        <select value={selected || ''} onChange={e => handleSelect(e.target.value)} style={selectStyle}>
          <option value="">— select —</option>
          <optgroup label="── base prompts ──">
            {templates.filter(t => !t.isVariant).map(t => (
              <option key={t.path} value={t.path}>{t.label}</option>
            ))}
          </optgroup>
          <optgroup label="── variants ──">
            {templates.filter(t => t.isVariant).map(t => (
              <option key={t.path} value={t.path}>{t.label}</option>
            ))}
          </optgroup>
        </select>

        {isVariant && (
          <div style={{ marginTop: '6px', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem', color: 'var(--forge-accent-dim)', padding: '3px 6px', background: 'var(--forge-surface)', borderRadius: '3px', border: '1px solid var(--forge-border)' }}>
            ⌥ variant
          </div>
        )}

        {selected && (
          <>
            <div style={{ marginTop: '12px' }}>
              <Label>frontmatter</Label>
              <div style={{
                background: 'var(--forge-surface)', border: '1px solid var(--forge-border)',
                borderRadius: '4px', padding: '8px', fontFamily: 'JetBrains Mono, monospace',
                fontSize: '0.65rem', color: 'var(--forge-muted)',
              }}>
                {Object.entries(frontmatter).map(([k, v]) => (
                  <div key={k}><span style={{ color: 'var(--forge-accent-dim)' }}>{k}:</span> {String(v)}</div>
                ))}
              </div>
            </div>

            <div style={{ marginTop: '12px' }}>
              <Label>temperature — {temperature}</Label>
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '6px' }}>
                {TEMP_PRESETS.map(p => (
                  <button key={p.value} onClick={() => setTemperature(p.value)} title={p.desc} style={{
                    background: temperature === p.value ? 'var(--forge-accent)' : 'var(--forge-surface)',
                    border: '1px solid var(--forge-border)',
                    color: temperature === p.value ? '#000' : 'var(--forge-muted)',
                    fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem',
                    padding: '3px 8px', cursor: 'pointer', borderRadius: '3px',
                  }}>{p.label}</button>
                ))}
              </div>
              <input type="range" min="0" max="1" step="0.05" value={temperature}
                onChange={e => setTemperature(parseFloat(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--forge-accent)' }}
              />
            </div>

            {/* Paper fetch */}
            <div style={{ marginTop: '12px' }}>
              <Label>paper / document url</Label>
              <PaperFetcher
                paperMeta={paperMeta}
                onFetched={setPaperMeta}
                onClear={() => setPaperMeta(null)}
              />
              {!paperMeta && (
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.58rem', color: 'var(--forge-border-bright)', marginTop: '4px', lineHeight: 1.6 }}>
                  arXiv · bioRxiv · PubMed · any URL
                </div>
              )}
            </div>

            {/* Context params */}
            <div style={{ marginTop: '12px' }}>
              <Label>context{params ? ` — ${params.split(',').length} fields` : ''}</Label>
              <ContextForm params={params} contextFields={contextFields} setContextFields={setContextFields} />
            </div>

            {/* Copy prompt */}
            <CopyPromptButton
              promptContent={promptContent}
              contextFields={contextFields}
              paperText={paperMeta?.text}
            />

            {/* Run button */}
            <button onClick={handleRun} disabled={streaming} style={{
              marginTop: '8px', width: '100%',
              background: streaming ? 'var(--forge-surface)' : 'var(--forge-accent)',
              border: 'none', color: streaming ? 'var(--forge-muted)' : '#000',
              fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.85rem',
              padding: '10px', cursor: streaming ? 'default' : 'pointer', borderRadius: '4px',
              letterSpacing: '0.05em',
            }}>{streaming ? '● streaming…' : '▶ run'}</button>
          </>
        )}

        {/* Rating */}
        {output && !streaming && (
          <div style={{ marginTop: '20px', borderTop: '1px solid var(--forge-border)', paddingTop: '16px' }}>
            <Label>rate this output</Label>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
              {[1, 2, 3, 4, 5].map(r => (
                <button key={r} onClick={() => setRating(r)} style={{
                  width: '32px', height: '32px',
                  background: rating === r ? 'var(--forge-accent)' : 'var(--forge-surface)',
                  border: '1px solid var(--forge-border)',
                  color: rating === r ? '#000' : 'var(--forge-muted)',
                  fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.85rem',
                  cursor: 'pointer', borderRadius: '4px',
                }}>{r}</button>
              ))}
            </div>
            <textarea value={note} onChange={e => setNote(e.target.value)}
              placeholder="what worked / what didn't…"
              style={{ ...fieldStyle, height: '60px', marginBottom: '8px', resize: 'vertical' }}
            />
            <button onClick={handleSaveRating} disabled={rating === null || saved} style={{
              width: '100%',
              background: saved ? 'var(--forge-green)' : 'var(--forge-surface)',
              border: `1px solid ${saved ? 'var(--forge-green)' : 'var(--forge-border)'}`,
              color: saved ? '#000' : 'var(--forge-muted)',
              fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem',
              padding: '6px', cursor: rating === null || saved ? 'default' : 'pointer', borderRadius: '4px',
            }}>{saved ? '✓ saved — visible in Improvements' : 'save rating'}</button>

            {saved && rating < 5 && (
              <button onClick={() => navigateTo('improvements')} style={{
                marginTop: '6px', width: '100%',
                background: 'none', border: '1px solid var(--forge-accent)',
                color: 'var(--forge-accent)', fontFamily: 'JetBrains Mono, monospace',
                fontSize: '0.65rem', padding: '6px', cursor: 'pointer', borderRadius: '4px',
              }}>↑ improve this prompt →</button>
            )}
          </div>
        )}
      </div>

      {/* Right panel — output */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{
          borderBottom: '1px solid var(--forge-border)', padding: '8px 16px',
          background: 'var(--forge-surface)', display: 'flex', alignItems: 'center', gap: '8px',
        }}>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-muted)' }}>output</span>
          {paperMeta && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem', color: 'var(--forge-green)' }}>📄 {paperMeta.source}</span>}
          {streaming && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-accent)' }}>● live</span>}
          {output && !streaming && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-green)' }}>✓ complete</span>}
          {output && (
            <button onClick={() => setOutput('')} style={{
              marginLeft: 'auto', background: 'none', border: '1px solid var(--forge-border)',
              color: 'var(--forge-muted)', fontFamily: 'JetBrains Mono, monospace',
              fontSize: '0.65rem', padding: '2px 8px', cursor: 'pointer', borderRadius: '3px',
            }}>clear</button>
          )}
        </div>
        <div ref={outputRef} style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
          {output ? (
            <pre style={{
              fontFamily: 'DM Sans, sans-serif', fontSize: '0.85rem', lineHeight: 1.8,
              color: 'var(--forge-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0,
            }}>{output}</pre>
          ) : (
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem', color: 'var(--forge-muted)' }}>
              {selected ? 'configure and run…' : 'select a prompt to begin'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const selectStyle = {
  width: '100%', background: 'var(--forge-surface)', border: '1px solid var(--forge-border)',
  color: 'var(--forge-text)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem',
  padding: '6px 8px', borderRadius: '4px', outline: 'none', cursor: 'pointer',
}
