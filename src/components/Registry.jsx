import { useState, useEffect, useMemo, useCallback } from 'react'
import { listVault, readFile, writeFile, parseFrontmatter, stripFrontmatter } from '../lib/obsidian.js'

const CATEGORIES = ['all', 'vc', 'learning', 'tools', 'reasoning', 'writing', 'research', 'other']

const CLASSIFIER_PROMPT = `You are a prompt librarian. Analyse the prompt text provided and return ONLY a JSON object with no preamble, no markdown, no backticks.

Return exactly this structure:
{
  "title": "Short descriptive title (3-5 words)",
  "slug": "kebab-case-slug",
  "category": "vc|learning|tools|reasoning|writing|research|other",
  "subcategory": "more specific type e.g. board-prep, competitive-dd, paper-digest",
  "params": "comma separated list of context variables this prompt needs at run time e.g. company, meeting, materials",
  "description": "One sentence describing what this prompt does",
  "suggested_path": "prompts/_templates/[category]/[slug].md"
}`

async function walkVault(path) {
  const items = await listVault(path)
  const allFiles = items.files || []
  const files = allFiles
    .filter(f => !f.endsWith('/') && f.endsWith('.md'))
    .map(f => path + f)
  const folders = allFiles
    .filter(f => f.endsWith('/'))
    .map(f => f.slice(0, -1))
  const nested = await Promise.all(folders.map(folder => walkVault(path + folder + '/')))
  return [...files, ...nested.flat()]
}

async function classifyPrompt(rawContent) {
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
      max_tokens: 500,
      messages: [{ role: 'user', content: `${CLASSIFIER_PROMPT}\n\nPrompt to classify:\n\n${rawContent}` }]
    })
  })
  const data = await res.json()
  const text = data.content?.[0]?.text || ''
  const clean = text.replace(/```json|```/g, '').trim()
  return JSON.parse(clean)
}

async function rewriteWithFrontmatter(path, classification, existingRaw) {
  const body = stripFrontmatter(existingRaw).trim()
  const existing = parseFrontmatter(existingRaw)
  const fm = `---
title: ${classification.title}
category: ${classification.category}
subcategory: ${classification.subcategory}
params: ${classification.params}
description: ${classification.description}
version: ${existing.version || '1'}
rating: ${existing.rating || 'null'}
last_used: ${existing.last_used || 'null'}
notes: ${existing.notes || '""'}
---

${body}
`
  await writeFile(path, fm)
}

function RatingPips({ value }) {
  if (!value || value === 'null') return (
    <span style={{ color: 'var(--forge-border-bright)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem' }}>—</span>
  )
  const n = parseInt(value)
  return (
    <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
      {[1, 2, 3, 4, 5].map(i => (
        <div key={i} style={{
          width: '6px', height: '6px', borderRadius: '50%',
          background: i <= n ? 'var(--forge-accent)' : 'var(--forge-border)',
          boxShadow: i <= n ? '0 0 4px var(--forge-accent)' : 'none',
        }} />
      ))}
    </div>
  )
}

function SortIcon({ col, sortCol, sortDir }) {
  if (sortCol !== col) return <span style={{ color: 'var(--forge-border-bright)', fontSize: '0.55rem' }}>⇅</span>
  return <span style={{ color: 'var(--forge-accent)', fontSize: '0.55rem' }}>{sortDir === 'asc' ? '↑' : '↓'}</span>
}

function ClassifyStatus({ status }) {
  if (!status) return null
  const colors = { classifying: 'var(--forge-accent)', done: 'var(--forge-green)', error: 'var(--forge-red)' }
  const labels = { classifying: '◌ classifying…', done: '✓ reclassified', error: '✕ failed' }
  return <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem', color: colors[status] }}>{labels[status]}</span>
}

export function Registry() {
  const [prompts, setPrompts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [category, setCategory] = useState('all')
  const [search, setSearch] = useState('')
  const [sortCol, setSortCol] = useState('last_used')
  const [sortDir, setSortDir] = useState('desc')
  const [selected, setSelected] = useState(null)
  const [classifyStatus, setClassifyStatus] = useState({})
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkProgress, setBulkProgress] = useState(null)

  const loadPrompts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const paths = await walkVault('prompts/')
      const templatePaths = paths.filter(p => !p.includes('/_context/') && !p.includes('/_archive/') && !p.includes('/_variants/'))
      const entries = await Promise.all(
        templatePaths.map(async (path) => {
          try {
            const raw = await readFile(path)
            const fm = parseFrontmatter(raw)
            return {
              path, raw,
              name: path.replace('prompts/_templates/', '').replace('prompts/', ''),
              title: fm.title || path.split('/').pop().replace('.md', ''),
              category: fm.category || 'other',
              subcategory: fm.subcategory || '',
              params: fm.params || '',
              description: fm.description || '',
              rating: fm.rating && fm.rating !== 'null' ? parseInt(fm.rating) : null,
              last_used: fm.last_used && fm.last_used !== 'null' ? fm.last_used : null,
              version: fm.version || '1',
              isUntyped: !fm.description || (!fm.subcategory && (!fm.category || fm.category === 'other')),
            }
          } catch { return null }
        })
      )
      setPrompts(entries.filter(Boolean))
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadPrompts() }, [loadPrompts])

  const handleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }

  const handleReclassify = async (p) => {
    setClassifyStatus(s => ({ ...s, [p.path]: 'classifying' }))
    try {
      const body = stripFrontmatter(p.raw).trim()
      const result = await classifyPrompt(body)
      await rewriteWithFrontmatter(p.path, result, p.raw)
      setPrompts(prev => prev.map(x => x.path !== p.path ? x : {
        ...x,
        title: result.title,
        category: result.category,
        subcategory: result.subcategory,
        params: result.params,
        description: result.description,
        isUntyped: false,
      }))
      setClassifyStatus(s => ({ ...s, [p.path]: 'done' }))
      setTimeout(() => setClassifyStatus(s => { const n = { ...s }; delete n[p.path]; return n }), 3000)
    } catch (e) {
      console.error(e)
      setClassifyStatus(s => ({ ...s, [p.path]: 'error' }))
      setTimeout(() => setClassifyStatus(s => { const n = { ...s }; delete n[p.path]; return n }), 4000)
    }
  }

  const handleBulkReclassify = async () => {
    const untyped = prompts.filter(p => p.isUntyped)
    if (!untyped.length) return
    setBulkRunning(true)
    setBulkProgress({ done: 0, total: untyped.length })
    for (let i = 0; i < untyped.length; i++) {
      const p = untyped[i]
      setClassifyStatus(s => ({ ...s, [p.path]: 'classifying' }))
      try {
        const body = stripFrontmatter(p.raw).trim()
        const result = await classifyPrompt(body)
        await rewriteWithFrontmatter(p.path, result, p.raw)
        setPrompts(prev => prev.map(x => x.path !== p.path ? x : {
          ...x,
          title: result.title, category: result.category,
          subcategory: result.subcategory, params: result.params,
          description: result.description, isUntyped: false,
        }))
        setClassifyStatus(s => ({ ...s, [p.path]: 'done' }))
      } catch {
        setClassifyStatus(s => ({ ...s, [p.path]: 'error' }))
      }
      setBulkProgress({ done: i + 1, total: untyped.length })
    }
    setBulkRunning(false)
    setTimeout(() => { setClassifyStatus({}); setBulkProgress(null) }, 4000)
  }

  const filtered = useMemo(() => {
    let rows = [...prompts]
    if (category !== 'all') rows = rows.filter(r => r.category === category)
    if (search.trim()) {
      const q = search.toLowerCase()
      rows = rows.filter(r =>
        r.title.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.subcategory.toLowerCase().includes(q) ||
        r.params.toLowerCase().includes(q)
      )
    }
    rows.sort((a, b) => {
      let av = a[sortCol] ?? '', bv = b[sortCol] ?? ''
      if (sortCol === 'rating') { av = a.rating ?? -1; bv = b.rating ?? -1 }
      if (sortCol === 'last_used') { av = a.last_used ?? '0000'; bv = b.last_used ?? '0000' }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return rows
  }, [prompts, category, search, sortCol, sortDir])

  const stats = useMemo(() => ({
    total: prompts.length,
    rated: prompts.filter(p => p.rating !== null).length,
    avgRating: prompts.filter(p => p.rating !== null).length
      ? (prompts.filter(p => p.rating !== null).reduce((s, p) => s + p.rating, 0) /
         prompts.filter(p => p.rating !== null).length).toFixed(1)
      : '—',
    untyped: prompts.filter(p => p.isUntyped).length,
  }), [prompts])

  const TH = (col, label, flex) => (
    <th onClick={() => handleSort(col)} style={{ ...thStyle, flex, cursor: 'pointer', userSelect: 'none', color: sortCol === col ? 'var(--forge-accent)' : 'var(--forge-muted)' }}>
      {label} <SortIcon col={col} sortCol={sortCol} sortDir={sortDir} />
    </th>
  )

  const selectedPrompt = selected ? prompts.find(x => x.path === selected) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 52px)', overflow: 'hidden' }}>

      {/* Toolbar */}
      <div style={{
        borderBottom: '1px solid var(--forge-border)', background: 'var(--forge-surface)',
        padding: '10px 16px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', gap: '16px', marginRight: '4px' }}>
          {[
            { label: 'prompts', value: stats.total },
            { label: 'rated', value: stats.rated },
            { label: 'avg rating', value: stats.avgRating },
            { label: 'untyped', value: stats.untyped, warn: stats.untyped > 0 },
          ].map(s => (
            <div key={s.label} style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem', color: 'var(--forge-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{s.label}</span>
              <span style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.95rem', color: s.warn ? 'var(--forge-red)' : 'var(--forge-accent)', lineHeight: 1.2 }}>
                {loading ? '…' : s.value}
              </span>
            </div>
          ))}
        </div>

        <div style={{ width: '1px', height: '28px', background: 'var(--forge-border)' }} />

        {!loading && stats.untyped > 0 && (
          <button onClick={handleBulkReclassify} disabled={bulkRunning} style={{
            background: bulkRunning ? 'var(--forge-surface)' : 'color-mix(in srgb, var(--forge-accent) 15%, transparent)',
            border: `1px solid ${bulkRunning ? 'var(--forge-border)' : 'var(--forge-accent)'}`,
            color: bulkRunning ? 'var(--forge-muted)' : 'var(--forge-accent)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem',
            padding: '4px 10px', cursor: bulkRunning ? 'default' : 'pointer', borderRadius: '3px',
          }}>
            {bulkRunning ? `◌ classifying ${bulkProgress?.done}/${bulkProgress?.total}…` : `⚡ classify ${stats.untyped} untyped`}
          </button>
        )}

        <div style={{ width: '1px', height: '28px', background: 'var(--forge-border)' }} />

        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {CATEGORIES.map(c => (
            <button key={c} onClick={() => setCategory(c)} style={{
              background: category === c ? 'var(--forge-accent)' : 'none',
              border: `1px solid ${category === c ? 'transparent' : 'var(--forge-border)'}`,
              color: category === c ? '#000' : 'var(--forge-muted)',
              fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem',
              padding: '3px 8px', cursor: 'pointer', borderRadius: '3px',
              textTransform: 'uppercase', letterSpacing: '0.06em', transition: 'all 0.12s',
            }}>{c}</button>
          ))}
        </div>

        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="search titles, descriptions, params…"
          style={{
            marginLeft: 'auto', background: 'var(--forge-bg)',
            border: '1px solid var(--forge-border)', color: 'var(--forge-text)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem',
            padding: '5px 10px', borderRadius: '4px', outline: 'none', width: '260px',
          }}
        />
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading ? (
          <div style={emptyStyle}><span style={{ animation: 'pulse 1.2s infinite' }}>◌ scanning vault…</span></div>
        ) : error ? (
          <div style={{ ...emptyStyle, color: 'var(--forge-red)' }}>{error}</div>
        ) : filtered.length === 0 ? (
          <div style={emptyStyle}>no prompts match</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ display: 'flex', borderBottom: '1px solid var(--forge-border)', background: 'var(--forge-surface)', position: 'sticky', top: 0, zIndex: 10 }}>
                {TH('title', 'title', '2 1 200px')}
                {TH('category', 'cat', '0 0 80px')}
                {TH('subcategory', 'type', '1 1 120px')}
                {TH('description', 'description', '3 1 300px')}
                {TH('params', 'params', '1 1 140px')}
                {TH('rating', 'rating', '0 0 90px')}
                {TH('last_used', 'last used', '0 0 100px')}
                <th style={{ ...thStyle, flex: '0 0 60px' }} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => {
                const status = classifyStatus[p.path]
                const isSelected = selected === p.path
                return (
                  <tr key={p.path}
                    onClick={() => setSelected(isSelected ? null : p.path)}
                    style={{
                      display: 'flex', borderBottom: '1px solid var(--forge-border)',
                      background: isSelected
                        ? 'color-mix(in srgb, var(--forge-accent) 8%, var(--forge-bg))'
                        : i % 2 === 0 ? 'var(--forge-bg)' : 'color-mix(in srgb, var(--forge-surface) 60%, var(--forge-bg))',
                      cursor: 'pointer',
                      borderLeft: isSelected ? '2px solid var(--forge-accent)'
                        : status === 'done' ? '2px solid var(--forge-green)'
                        : status === 'classifying' ? '2px solid var(--forge-accent)'
                        : '2px solid transparent',
                      transition: 'background 0.1s',
                      opacity: status === 'classifying' ? 0.7 : 1,
                    }}
                  >
                    <td style={{ ...tdStyle, flex: '2 1 200px', fontWeight: 500, gap: '8px' }}>
                      <span style={{ display: 'block', fontFamily: 'JetBrains Mono, monospace' }}>{p.name.split('/').pop().replace('.md','')}</span>
                      <span style={{ display: 'block', fontSize: '0.65rem', color: 'var(--forge-muted)', fontFamily: 'DM Sans, sans-serif' }}>{p.title}</span>  
                      {status && <ClassifyStatus status={status} />}
                    </td>
                    <td style={{ ...tdStyle, flex: '0 0 80px' }}>
                      <span style={{
                        fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
                        color: catColor(p.category),
                        background: `color-mix(in srgb, ${catColor(p.category)} 12%, transparent)`,
                        border: `1px solid color-mix(in srgb, ${catColor(p.category)} 30%, transparent)`,
                        padding: '2px 5px', borderRadius: '3px', textTransform: 'uppercase', letterSpacing: '0.06em',
                      }}>{p.category}</span>
                    </td>
                    <td style={{ ...tdStyle, flex: '1 1 120px', color: 'var(--forge-muted)', fontSize: '0.68rem' }}>{p.subcategory || '—'}</td>
                    <td style={{ ...tdStyle, flex: '3 1 300px', color: 'var(--forge-muted)', fontSize: '0.68rem' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{p.description || '—'}</span>
                    </td>
                    <td style={{ ...tdStyle, flex: '1 1 140px' }}>
                      {p.params ? (
                        <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                          {p.params.split(',').map(s => s.trim()).filter(Boolean).map(param => (
                            <span key={param} style={{
                              fontFamily: 'JetBrains Mono, monospace', fontSize: '0.58rem',
                              color: 'var(--forge-accent-dim)', background: 'var(--forge-surface)',
                              border: '1px solid var(--forge-border)', padding: '1px 4px', borderRadius: '2px',
                            }}>{param}</span>
                          ))}
                        </div>
                      ) : <span style={{ color: 'var(--forge-border-bright)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem' }}>—</span>}
                    </td>
                    <td style={{ ...tdStyle, flex: '0 0 90px' }}><RatingPips value={p.rating} /></td>
                    <td style={{ ...tdStyle, flex: '0 0 100px', color: 'var(--forge-muted)', fontSize: '0.65rem', fontFamily: 'JetBrains Mono, monospace' }}>{p.last_used || '—'}</td>
                    <td style={{ ...tdStyle, flex: '0 0 60px', justifyContent: 'center' }}
                      onClick={e => { e.stopPropagation(); handleReclassify(p) }}>
                      <button disabled={!!status} title="Re-classify with AI" style={{
                        background: 'none',
                        border: `1px solid ${p.isUntyped ? 'var(--forge-accent)' : 'var(--forge-border)'}`,
                        color: p.isUntyped ? 'var(--forge-accent)' : 'var(--forge-muted)',
                        fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
                        padding: '2px 6px', cursor: status ? 'default' : 'pointer', borderRadius: '3px',
                        opacity: status === 'classifying' ? 0.5 : 1,
                      }}>{status === 'classifying' ? '◌' : '⚡'}</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail drawer */}
      {selectedPrompt && (
        <div style={{
          borderTop: '1px solid var(--forge-accent)',
          background: 'color-mix(in srgb, var(--forge-surface) 95%, var(--forge-bg))',
          padding: '14px 20px', display: 'flex', gap: '24px', alignItems: 'flex-start', flexWrap: 'wrap',
        }}>
          <div style={{ flex: '2 1 300px' }}>
            <div style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.9rem', color: 'var(--forge-text)', marginBottom: '4px' }}>{selectedPrompt.title}</div>
            <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '0.78rem', color: 'var(--forge-muted)', lineHeight: 1.6 }}>
              {selectedPrompt.description || <span style={{ fontStyle: 'italic' }}>no description — re-classify to generate one</span>}
            </div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem', color: 'var(--forge-border-bright)', marginTop: '6px' }}>{selectedPrompt.path}</div>
          </div>
          <div style={{ display: 'flex', gap: '20px', flex: '1 1 auto', flexWrap: 'wrap', alignItems: 'center' }}>
            {[
              { label: 'category', value: selectedPrompt.category },
              { label: 'type', value: selectedPrompt.subcategory || '—' },
              { label: 'version', value: `v${selectedPrompt.version}` },
              { label: 'last used', value: selectedPrompt.last_used || 'never' },
            ].map(f => (
              <div key={f.label}>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.58rem', color: 'var(--forge-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '3px' }}>{f.label}</div>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem', color: 'var(--forge-text)' }}>{f.value}</div>
              </div>
            ))}
            <div>
              <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.58rem', color: 'var(--forge-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '5px' }}>rating</div>
              <RatingPips value={selectedPrompt.rating} />
            </div>
            <button onClick={() => handleReclassify(selectedPrompt)}
              disabled={!!classifyStatus[selectedPrompt.path]}
              style={{
                background: 'color-mix(in srgb, var(--forge-accent) 15%, transparent)',
                border: '1px solid var(--forge-accent)', color: 'var(--forge-accent)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem',
                padding: '5px 12px', cursor: classifyStatus[selectedPrompt.path] ? 'default' : 'pointer',
                borderRadius: '3px', opacity: classifyStatus[selectedPrompt.path] ? 0.5 : 1,
              }}>
              {classifyStatus[selectedPrompt.path] === 'classifying' ? '◌ classifying…'
                : classifyStatus[selectedPrompt.path] === 'done' ? '✓ done'
                : '⚡ re-classify'}
            </button>
          </div>
          <button onClick={() => setSelected(null)} style={{
            background: 'none', border: '1px solid var(--forge-border)', color: 'var(--forge-muted)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem',
            padding: '3px 8px', cursor: 'pointer', borderRadius: '3px', alignSelf: 'flex-start',
          }}>✕</button>
        </div>
      )}

      <style>{`@keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.4 } }`}</style>
    </div>
  )
}

function catColor(cat) {
  const map = { vc: '#f59e0b', learning: '#3b82f6', tools: '#8b5cf6', reasoning: '#10b981', writing: '#ec4899', research: '#06b6d4', other: '#6b7280' }
  return map[cat] || map.other
}

const thStyle = {
  display: 'flex', alignItems: 'center', padding: '7px 12px',
  fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
  textTransform: 'uppercase', letterSpacing: '0.1em',
  background: 'none', border: 'none', textAlign: 'left',
}

const tdStyle = {
  padding: '8px 12px', fontFamily: 'DM Sans, sans-serif', fontSize: '0.75rem',
  color: 'var(--forge-text)', display: 'flex', alignItems: 'center', overflow: 'hidden',
}

const emptyStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px',
  fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem', color: 'var(--forge-muted)',
}
