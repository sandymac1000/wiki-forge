import { useState, useEffect, useCallback, useRef } from 'react'
import { listVault, readFile, writeFile, deleteFile, parseFrontmatter, stripFrontmatter } from '../lib/obsidian.js'
import { runPrompt } from '../lib/anthropic.js'

// ── Prompts ───────────────────────────────────────────────────────────────────

const GENERATE_SYSTEM = `You are an expert prompt engineer. Given a base prompt, generate 3 distinct variants that achieve the same goal but with meaningfully different approaches or styles.

Return ONLY a JSON object with no preamble, no markdown, no backticks:
{
  "variants": [
    {
      "name": "analytical",
      "label": "Analytical",
      "description": "One sentence describing this approach",
      "prompt": "the full prompt text"
    },
    {
      "name": "concise",
      "label": "Concise",
      "description": "One sentence describing this approach",
      "prompt": "the full prompt text"
    },
    {
      "name": "socratic",
      "label": "Socratic",
      "description": "One sentence describing this approach",
      "prompt": "the full prompt text"
    }
  ]
}`

// ── Paper fetch ───────────────────────────────────────────────────────────────

function extractArxivId(url) {
  const m = url.match(/arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}(?:v\d+)?)/)
  return m ? m[1] : null
}

function htmlToText(html) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<\/?(p|div|section|article|h[1-6]|li|br)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim()
  const words = text.split(/\s+/)
  if (words.length > 6000) text = words.slice(0, 6000).join(' ') + '\n\n[truncated]'
  return text
}

async function fetchPaper(url) {
  url = url.trim()
  const arxivId = extractArxivId(url)
  if (arxivId) {
    try {
      const res = await fetch(`/paperfetch?url=${encodeURIComponent(`https://arxiv.org/html/${arxivId}`)}`)
      if (res.ok) {
        const text = htmlToText(await res.text())
        if (text.length > 200) return { text, source: `arXiv:${arxivId}` }
      }
    } catch {}
    const res2 = await fetch(`/paperfetch?url=${encodeURIComponent(`https://arxiv.org/abs/${arxivId}`)}`)
    if (res2.ok) return { text: htmlToText(await res2.text()), source: `arXiv:${arxivId} (abstract)` }
    throw new Error('arXiv fetch failed — paste abstract text directly')
  }
  // bioRxiv
  const bm = url.match(/biorxiv\.org\/content\/(10\.\d{4,}\/[^\s?#]+)/)
  if (bm) {
    const res = await fetch(`/paperfetch?url=${encodeURIComponent(`https://www.biorxiv.org/content/${bm[1]}v1`)}`)
    if (res.ok) return { text: htmlToText(await res.text()), source: `bioRxiv:${bm[1]}` }
    throw new Error('bioRxiv fetch failed — paste abstract text directly')
  }
  // PubMed
  const pm = url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/)
  if (pm) {
    const res = await fetch(`/paperfetch?url=${encodeURIComponent(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pm[1]}&rettype=abstract&retmode=text`)}`)
    if (res.ok) return { text: await res.text(), source: `PubMed:${pm[1]}` }
    throw new Error('PubMed fetch failed')
  }
  // Generic
  const res = await fetch(`/paperfetch?url=${encodeURIComponent(url)}`)
  if (res.ok) {
    const text = htmlToText(await res.text())
    if (text.length < 100) throw new Error('Page too short — paste text directly')
    return { text, source: url }
  }
  throw new Error('Could not fetch — paste text directly')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function walkVault(path) {
  const items = await listVault(path)
  const allFiles = items.files || []
  const files = allFiles.filter(f => !f.endsWith('/') && f.endsWith('.md')).map(f => path + f)
  const folders = allFiles.filter(f => f.endsWith('/')).map(f => f.slice(0, -1))
  const nested = await Promise.all(folders.map(folder => walkVault(path + folder + '/')))
  return [...files, ...nested.flat()]
}

async function generateVariants(baseBody) {
  const res = await fetch('/anthropic/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': import.meta.env.VITE_ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      system: GENERATE_SYSTEM,
      messages: [{ role: 'user', content: `Base prompt:\n\n${baseBody}` }]
    })
  })
  const data = await res.json()
  const text = data.content?.[0]?.text || ''
  return JSON.parse(text.replace(/```json|```/g, '').trim())
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Label({ children }) {
  return (
    <div style={{
      fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
      color: 'var(--forge-muted)', textTransform: 'uppercase',
      letterSpacing: '0.1em', marginBottom: '4px',
    }}>{children}</div>
  )
}

function WinRate({ wins, runs }) {
  if (!runs) return <span style={{ color: 'var(--forge-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem' }}>no races</span>
  const pct = Math.round((wins / runs) * 100)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <div style={{ width: '50px', height: '4px', background: 'var(--forge-border)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--forge-accent)', borderRadius: '2px' }} />
      </div>
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem', color: 'var(--forge-accent)' }}>{pct}%</span>
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.58rem', color: 'var(--forge-muted)' }}>{wins}/{runs}</span>
    </div>
  )
}

function PaperFetcher({ paperMeta, onFetched, onClear }) {
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
    } catch (e) { setFetchError(e.message) }
    setFetching(false)
  }

  if (paperMeta) return (
    <div style={{
      background: 'color-mix(in srgb, var(--forge-green) 8%, var(--forge-surface))',
      border: '1px solid color-mix(in srgb, var(--forge-green) 25%, transparent)',
      borderRadius: '4px', padding: '6px 10px',
      display: 'flex', alignItems: 'center', gap: '8px',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.58rem', color: 'var(--forge-green)' }}>✓ paper loaded</div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem', color: 'var(--forge-muted)', wordBreak: 'break-all' }}>{paperMeta.source}</div>
      </div>
      <button onClick={onClear} style={{ background: 'none', border: '1px solid var(--forge-border)', color: 'var(--forge-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem', padding: '2px 6px', cursor: 'pointer', borderRadius: '3px' }}>✕</button>
    </div>
  )

  return (
    <div>
      <div style={{ display: 'flex', gap: '4px' }}>
        <input
          value={url} onChange={e => { setUrl(e.target.value); setFetchError(null) }}
          onKeyDown={e => e.key === 'Enter' && handleFetch()}
          placeholder="arxiv.org/abs/… or biorxiv.org/…"
          style={{
            flex: 1, background: 'var(--forge-surface)', border: '1px solid var(--forge-border)',
            color: 'var(--forge-text)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.68rem',
            padding: '5px 8px', borderRadius: '4px', outline: 'none',
          }}
        />
        <button onClick={handleFetch} disabled={!url.trim() || fetching} style={{
          background: fetching ? 'var(--forge-surface)' : 'var(--forge-accent)',
          border: 'none', color: fetching ? 'var(--forge-muted)' : '#000',
          fontFamily: 'JetBrains Mono, monospace', fontSize: '0.68rem', fontWeight: 600,
          padding: '5px 10px', cursor: !url.trim() || fetching ? 'default' : 'pointer', borderRadius: '4px',
        }}>{fetching ? '◌' : '↓ fetch'}</button>
      </div>
      {fetchError && <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem', color: 'var(--forge-red)', marginTop: '4px', lineHeight: 1.5 }}>{fetchError}</div>}
    </div>
  )
}

function SavedChampion({ variant, onDelete, onChallenge }) {
  return (
    <div style={{
      padding: '10px 14px', background: 'var(--forge-surface)',
      border: '1px solid var(--forge-border)', borderRadius: '4px',
      display: 'flex', alignItems: 'center', gap: '12px',
    }}>
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem', color: 'var(--forge-accent)' }}>★</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: 'Syne, sans-serif', fontWeight: 600, fontSize: '0.78rem', color: 'var(--forge-text)' }}>{variant.label}</div>
        <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '0.68rem', color: 'var(--forge-muted)', marginTop: '2px' }}>{variant.description}</div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.58rem', color: 'var(--forge-muted)', marginTop: '3px' }}>
          rating: <span style={{ color: 'var(--forge-accent)' }}>{variant.rating ?? '—'}/5</span>
        </div>
      </div>
      <WinRate wins={variant.wins} runs={variant.runs} />
      <button onClick={() => onChallenge(variant)} style={{
        background: 'none', border: '1px solid var(--forge-accent)', color: 'var(--forge-accent)',
        fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
        padding: '3px 8px', cursor: 'pointer', borderRadius: '3px',
      }}>⚔ challenge</button>
      <button onClick={() => onDelete(variant)} style={{
        background: 'none', border: '1px solid var(--forge-border)', color: 'var(--forge-muted)',
        fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
        padding: '3px 6px', cursor: 'pointer', borderRadius: '3px',
      }}>✕</button>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function Variants({ navigateTo }) {
  const [basePrompts, setBasePrompts] = useState([])
  const [selectedBase, setSelectedBase] = useState(null)
  const [savedVariants, setSavedVariants] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Ephemeral race state
  const [raceVariants, setRaceVariants] = useState([])
  const [raceContext, setRaceContext] = useState('')
  const [paperMeta, setPaperMeta] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [racing, setRacing] = useState(false)
  const [outputs, setOutputs] = useState({})
  const [raceComplete, setRaceComplete] = useState(false)
  const [voted, setVoted] = useState(null)
  const [champion, setChampion] = useState(null)
  const outputRefs = useRef({})

  const loadBase = useCallback(async () => {
    setLoading(true)
    try {
      const paths = await walkVault('prompts/')
      const filtered = paths.filter(p =>
        !p.includes('/_context/') && !p.includes('/_archive/') && !p.includes('/_variants/')
      )
      const entries = await Promise.all(filtered.map(async path => {
        try {
          const raw = await readFile(path)
          const fm = parseFrontmatter(raw)
          const slug = path.split('/').pop().replace('.md', '')
          return { path, raw, slug, title: fm.title || slug, category: fm.category || 'other', subcategory: fm.subcategory || '', params: fm.params || '', description: fm.description || '', body: stripFrontmatter(raw).trim() }
        } catch { return null }
      }))
      setBasePrompts(entries.filter(Boolean))
    } catch (e) { setError(e.message) }
    setLoading(false)
  }, [])

  useEffect(() => { loadBase() }, [loadBase])

  const loadSavedVariants = useCallback(async (slug) => {
    try {
      const variantPath = `prompts/_variants/${slug}/`
      let items
      try { items = await listVault(variantPath) }
      catch { setSavedVariants([]); return }
      const files = (items.files || []).filter(f => !f.endsWith('/') && f.endsWith('.md'))
      const loaded = await Promise.all(files.map(async f => {
        try {
          const raw = await readFile(`${variantPath}${f}`)
          const fm = parseFrontmatter(raw)
          return {
            name: f.replace('.md', ''),
            label: fm.label || f.replace('.md', ''),
            description: fm.description || '',
            body: stripFrontmatter(raw).trim(),
            wins: parseInt(fm.wins || '0'),
            runs: parseInt(fm.runs || '0'),
            rating: fm.rating && fm.rating !== 'null' ? parseInt(fm.rating) : null,
            path: `${variantPath}${f}`,
            raw,
          }
        } catch { return null }
      }))
      setSavedVariants(loaded.filter(Boolean))
    } catch { setSavedVariants([]) }
  }, [])

  const handleSelectBase = (p) => {
    setSelectedBase(p)
    resetRace()
    setError(null)
    loadSavedVariants(p.slug)
  }

  const resetRace = () => {
    setRaceVariants([])
    setOutputs({})
    setVoted(null)
    setRaceComplete(false)
    setChampion(null)
    setRaceContext('')
    setPaperMeta(null)
  }

  const handleGenerate = async (challengerTo = null) => {
    if (!selectedBase) return
    setGenerating(true)
    setError(null)
    resetRace()
    setChampion(challengerTo)
    try {
      const parsed = await generateVariants(selectedBase.body)
      if (challengerTo) {
        setRaceVariants([
          { name: challengerTo.name, label: `★ ${challengerTo.label}`, description: challengerTo.description, body: challengerTo.body, isChampion: true },
          ...parsed.variants.slice(0, 2).map(v => ({ ...v, isChampion: false }))
        ])
      } else {
        setRaceVariants(parsed.variants.map(v => ({ ...v, isChampion: false })))
      }
    } catch (e) { setError(`Generation failed: ${e.message}`) }
    setGenerating(false)
  }

  const handleRace = async () => {
    if (!raceVariants.length || racing) return
    setRacing(true)
    setOutputs({})
    setVoted(null)
    setRaceComplete(false)

    const userMsg = paperMeta?.text
      ? `## Paper / Document\nSource: ${paperMeta.source}\n\n${paperMeta.text}${raceContext ? `\n\n## Context\n${raceContext}` : ''}`
      : raceContext || (selectedBase?.body?.toLowerCase().match(/paper|document|material|report|pdf/)
    ? '---\nNOTE: No document has been provided. Before proceeding, ask the user to share the paper, report or materials needed to complete this task. Do not attempt to answer without them.\n---'
    : 'Begin.')

    await Promise.all(raceVariants.map(async v => {
      try {
        await runPrompt({
          system: v.body,
          user: userMsg,
          temperature: 0.7,
          onChunk: (chunk, full) => {
            setOutputs(prev => ({ ...prev, [v.name]: full }))
            if (outputRefs.current[v.name]) outputRefs.current[v.name].scrollTop = outputRefs.current[v.name].scrollHeight
          }
        })
      } catch (e) {
        setOutputs(prev => ({ ...prev, [v.name]: `Error: ${e.message}` }))
      }
    }))
    setRacing(false)
    setRaceComplete(true)
  }

  // Vote — winner saved with rating:4, wins:1, runs:1
  // Rating 4 = "good, beat peers, not yet battle-tested" → shows in Improvements
  const handleVote = async (winnerName) => {
    if (voted || !selectedBase) return
    setVoted(winnerName)

    const winner = raceVariants.find(v => v.name === winnerName)
    if (!winner) return
    const base = selectedBase

    if (winner.isChampion) {
      // Champion survived — bump wins + runs, keep rating
      const existing = savedVariants.find(v => v.name === winnerName)
      if (existing) {
        const fm = parseFrontmatter(existing.raw)
        await writeFile(existing.path, buildVariantFm({
          label: fm.label || winner.label,
          description: fm.description || winner.description,
          slug: base.slug,
          category: base.category,
          subcategory: base.subcategory,
          params: base.params,
          wins: parseInt(fm.wins || '0') + 1,
          runs: parseInt(fm.runs || '0') + 1,
          rating: fm.rating || '4',
          body: winner.body,
        }))
        // Update losers' run counts
        await bumpLosers(raceVariants, winnerName, savedVariants, base)
      }
    } else {
      // New challenger won — save with rating:4
      const savePath = `prompts/_variants/${base.slug}/${winner.name}.md`
      await writeFile(savePath, buildVariantFm({
        label: winner.label,
        description: winner.description,
        slug: base.slug,
        category: base.category,
        subcategory: base.subcategory,
        params: base.params,
        wins: 1,
        runs: 1,
        rating: 4,
        body: winner.body,
      }))
      // Bump champion's run count (it lost)
      if (champion) {
        const existing = savedVariants.find(v => v.name === champion.name)
        if (existing) {
          const fm = parseFrontmatter(existing.raw)
          await writeFile(existing.path, buildVariantFm({
            label: fm.label || champion.label,
            description: fm.description || champion.description,
            slug: base.slug,
            category: base.category,
            subcategory: base.subcategory,
            params: base.params,
            wins: parseInt(fm.wins || '0'),
            runs: parseInt(fm.runs || '0') + 1,
            rating: fm.rating || '4',
            body: champion.body,
          }))
        }
      }
    }
    await loadSavedVariants(base.slug)
  }

  const handleDelete = async (variant) => {
    if (!confirm(`Delete "${variant.label}"?`)) return
    try {
      await deleteFile(variant.path)
      await loadSavedVariants(selectedBase.slug)
    } catch (e) { setError(e.message) }
  }

  const winnerVariant = voted ? raceVariants.find(v => v.name === voted) : null
  const hasOutputs = Object.keys(outputs).length > 0

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 52px)', overflow: 'hidden' }}>

      {/* Left panel */}
      <div style={{ width: '240px', minWidth: '240px', borderRight: '1px solid var(--forge-border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--forge-border)', background: 'var(--forge-surface)' }}>
          <Label>base prompt</Label>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem', color: 'var(--forge-muted)', marginTop: '2px' }}>
            {loading ? '…' : `${basePrompts.length} prompts`}
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {basePrompts.map(p => (
            <div key={p.path} onClick={() => handleSelectBase(p)} style={{
              padding: '9px 14px', cursor: 'pointer',
              borderBottom: '1px solid var(--forge-border)',
              borderLeft: selectedBase?.path === p.path ? '2px solid var(--forge-accent)' : '2px solid transparent',
              background: selectedBase?.path === p.path ? 'color-mix(in srgb, var(--forge-accent) 6%, var(--forge-bg))' : 'transparent',
              transition: 'all 0.1s',
            }}>
              <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '0.75rem', color: 'var(--forge-text)', fontWeight: 500 }}>{p.title}</div>
              <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.58rem', color: 'var(--forge-muted)', marginTop: '2px' }}>{p.slug}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!selectedBase ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '8px' }}>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem', color: 'var(--forge-muted)' }}>select a base prompt</div>
            <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '0.75rem', color: 'var(--forge-border-bright)', maxWidth: '340px', textAlign: 'center', lineHeight: 1.7 }}>
              Generate 3 variants · race on the same context · vote for the winner<br />
              Only the winner is saved · vote counts as a rating of 4
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div style={{ borderBottom: '1px solid var(--forge-border)', padding: '10px 16px', background: 'var(--forge-surface)', display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.9rem', color: 'var(--forge-text)' }}>{selectedBase.title}</div>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem', color: 'var(--forge-muted)', marginTop: '2px' }}>
                  {savedVariants.length > 0 ? `${savedVariants.length} saved champion${savedVariants.length > 1 ? 's' : ''}` : 'no saved variants yet'}
                </div>
              </div>
              {!hasOutputs && !raceVariants.length && (
                <button onClick={() => handleGenerate(null)} disabled={generating} style={{
                  background: generating ? 'var(--forge-surface)' : 'var(--forge-accent)',
                  border: 'none', color: generating ? 'var(--forge-muted)' : '#000',
                  fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.8rem',
                  padding: '7px 16px', cursor: generating ? 'default' : 'pointer', borderRadius: '4px',
                }}>{generating ? '◌ generating…' : '⚡ generate & race'}</button>
              )}
            </div>

            {error && <div style={{ padding: '8px 16px', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem', color: 'var(--forge-red)', borderBottom: '1px solid var(--forge-border)' }}>{error}</div>}

            {/* Saved champions */}
            {!hasOutputs && !raceVariants.length && savedVariants.length > 0 && (
              <div style={{ padding: '16px', borderBottom: '1px solid var(--forge-border)' }}>
                <Label>saved champions — ⚔ challenge to race new variants against one</Label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                  {savedVariants.map(v => (
                    <SavedChampion key={v.name} variant={v} onDelete={handleDelete} onChallenge={handleGenerate} />
                  ))}
                </div>
              </div>
            )}

            {/* Race setup */}
            {!hasOutputs && raceVariants.length > 0 && (
              <div style={{ padding: '16px', borderBottom: '1px solid var(--forge-border)' }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div>
                      <Label>racers</Label>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {raceVariants.map(v => (
                          <span key={v.name} style={{
                            fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
                            color: v.isChampion ? 'var(--forge-accent)' : 'var(--forge-muted)',
                            background: 'var(--forge-surface)',
                            border: `1px solid ${v.isChampion ? 'var(--forge-accent)' : 'var(--forge-border)'}`,
                            padding: '2px 8px', borderRadius: '3px',
                          }}>{v.label}</span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <Label>paper / document url (optional)</Label>
                      <PaperFetcher paperMeta={paperMeta} onFetched={setPaperMeta} onClear={() => setPaperMeta(null)} />
                    </div>
                    <div>
                      <Label>additional context (optional)</Label>
                      <textarea
                        value={raceContext}
                        onChange={e => setRaceContext(e.target.value)}
                        placeholder="Topic, company name, question to answer…"
                        style={{
                          width: '100%', background: 'var(--forge-surface)', border: '1px solid var(--forge-border)',
                          color: 'var(--forge-text)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem',
                          padding: '8px', borderRadius: '4px', outline: 'none', resize: 'vertical',
                          lineHeight: 1.6, minHeight: '50px',
                        }}
                      />
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '22px' }}>
                    <button onClick={handleRace} disabled={racing} style={{
                      background: 'var(--forge-accent)', border: 'none', color: '#000',
                      fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.85rem',
                      padding: '10px 20px', cursor: racing ? 'default' : 'pointer', borderRadius: '4px',
                      letterSpacing: '0.04em', whiteSpace: 'nowrap',
                    }}>{racing ? '● racing…' : '▶ race'}</button>
                    <button onClick={resetRace} style={{
                      background: 'none', border: '1px solid var(--forge-border)', color: 'var(--forge-muted)',
                      fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem',
                      padding: '6px', cursor: 'pointer', borderRadius: '4px',
                    }}>cancel</button>
                  </div>
                </div>
              </div>
            )}

            {/* Empty state */}
            {!hasOutputs && !raceVariants.length && savedVariants.length === 0 && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '0.82rem', color: 'var(--forge-muted)', maxWidth: '360px', textAlign: 'center', lineHeight: 1.8 }}>
                  Click <strong style={{ color: 'var(--forge-accent)' }}>⚡ generate & race</strong> to create 3 variants.<br />
                  Race them on the same context, vote for the best.<br />
                  <span style={{ fontSize: '0.75rem', color: 'var(--forge-border-bright)' }}>Only the winner is saved · rated 4/5 automatically</span>
                </div>
              </div>
            )}

            {/* Race outputs */}
            {hasOutputs && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {/* Status bar */}
                <div style={{
                  padding: '10px 16px', borderBottom: '1px solid var(--forge-border)',
                  background: voted ? 'color-mix(in srgb, var(--forge-accent) 8%, var(--forge-surface))' : 'var(--forge-surface)',
                  display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
                }}>
                  {!raceComplete && !voted && (
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-accent)' }}>● streaming all variants simultaneously…</span>
                  )}
                  {raceComplete && !voted && (
                    <>
                      <span style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.85rem', color: 'var(--forge-text)' }}>Which is best?</span>
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-muted)' }}>Click a column header to vote — winner saved with rating 4/5, goes to Improvements</span>
                      <button onClick={() => { setOutputs({}); setRaceComplete(false) }} style={{
                        marginLeft: 'auto', background: 'none', border: '1px solid var(--forge-border)',
                        color: 'var(--forge-muted)', fontFamily: 'JetBrains Mono, monospace',
                        fontSize: '0.65rem', padding: '4px 10px', cursor: 'pointer', borderRadius: '3px',
                      }}>↺ re-race</button>
                    </>
                  )}
                  {voted && winnerVariant && (
                    <>
                      <span style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.88rem', color: 'var(--forge-accent)' }}>
                        ★ {winnerVariant.label} wins · saved · rated 4/5
                      </span>
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
                        <button onClick={() => handleGenerate(champion)} style={{
                          background: 'none', border: '1px solid var(--forge-border)', color: 'var(--forge-muted)',
                          fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem',
                          padding: '5px 12px', cursor: 'pointer', borderRadius: '4px',
                        }}>⚔ race again</button>
                        <button onClick={() => navigateTo('improvements')} style={{
                          background: 'none', border: '1px solid var(--forge-accent)', color: 'var(--forge-accent)',
                          fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem',
                          padding: '5px 14px', cursor: 'pointer', borderRadius: '4px',
                        }}>↑ Improvements →</button>
                        <button onClick={() => navigateTo('runner')} style={{
                          background: 'var(--forge-accent)', border: 'none', color: '#000',
                          fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.78rem',
                          padding: '5px 16px', cursor: 'pointer', borderRadius: '4px',
                        }}>Use in Runner →</button>
                      </div>
                    </>
                  )}
                </div>

                {/* Side by side outputs */}
                <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                  {raceVariants.map((v, i) => {
                    const isWinner = voted === v.name
                    const isLoser = voted && voted !== v.name
                    return (
                      <div key={v.name} style={{
                        flex: 1, display: 'flex', flexDirection: 'column',
                        borderRight: i < raceVariants.length - 1 ? '1px solid var(--forge-border)' : 'none',
                        overflow: 'hidden', opacity: isLoser ? 0.35 : 1, transition: 'opacity 0.35s',
                      }}>
                        <div
                          onClick={() => raceComplete && !voted && handleVote(v.name)}
                          style={{
                            padding: '8px 14px',
                            background: isWinner ? 'color-mix(in srgb, var(--forge-accent) 15%, var(--forge-surface))' : v.isChampion ? 'color-mix(in srgb, var(--forge-accent) 5%, var(--forge-surface))' : 'var(--forge-surface)',
                            borderBottom: `1px solid ${isWinner ? 'var(--forge-accent)' : 'var(--forge-border)'}`,
                            cursor: raceComplete && !voted ? 'pointer' : 'default',
                            display: 'flex', alignItems: 'center', gap: '8px',
                            transition: 'background 0.2s',
                          }}
                        >
                          <div style={{ flex: 1 }}>
                            <div style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.78rem', color: isWinner ? 'var(--forge-accent)' : v.isChampion ? 'var(--forge-accent-dim)' : 'var(--forge-text)' }}>
                              {isWinner && '★ '}{v.label}
                            </div>
                            <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '0.65rem', color: 'var(--forge-muted)' }}>{v.description}</div>
                          </div>
                          {raceComplete && !voted && (
                            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem', color: 'var(--forge-accent)', border: '1px solid var(--forge-accent)', padding: '2px 7px', borderRadius: '3px' }}>vote ↑</span>
                          )}
                        </div>
                        <div ref={el => outputRefs.current[v.name] = el} style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
                          {outputs[v.name] ? (
                            <pre style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '0.78rem', lineHeight: 1.8, color: 'var(--forge-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
                              {outputs[v.name]}
                            </pre>
                          ) : (
                            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-muted)', animation: 'pulse 1.2s infinite' }}>streaming…</div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
    </div>
  )
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function buildVariantFm({ label, description, slug, category, subcategory, params, wins, runs, rating, body }) {
  return `---
label: ${label}
description: ${description}
base: ${slug}
category: ${category || 'other'}
subcategory: ${subcategory || ''}
params: ${params || ''}
wins: ${wins}
runs: ${runs}
rating: ${rating}
last_used: ${new Date().toISOString().split('T')[0]}
notes: ""
---

${body}
`
}

async function bumpLosers(raceVariants, winnerName, savedVariants, base) {
  const losers = raceVariants.filter(v => v.name !== winnerName && v.isChampion)
  await Promise.all(losers.map(async v => {
    const existing = savedVariants.find(sv => sv.name === v.name)
    if (!existing) return
    const fm = parseFrontmatter(existing.raw)
    await writeFile(existing.path, buildVariantFm({
      label: fm.label || v.label,
      description: fm.description || v.description,
      slug: base.slug,
      category: base.category,
      subcategory: base.subcategory,
      params: base.params,
      wins: parseInt(fm.wins || '0'),
      runs: parseInt(fm.runs || '0') + 1,
      rating: fm.rating || '4',
      body: v.body,
    }))
  }))
}
