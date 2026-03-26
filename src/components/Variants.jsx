import { useState, useEffect, useCallback, useRef } from 'react'
import { listVault, readFile, writeFile, parseFrontmatter, stripFrontmatter } from '../lib/obsidian.js'
import { runPrompt } from '../lib/anthropic.js'

const GENERATE_SYSTEM = `You are an expert prompt engineer. Given a base prompt, generate 3 distinct variants that achieve the same goal but with meaningfully different approaches or styles.

Return ONLY a JSON object with no preamble, no markdown, no backticks:
{
  "variants": [
    {
      "name": "analytical",
      "label": "Analytical",
      "description": "One sentence describing the approach",
      "prompt": "the full prompt text"
    },
    {
      "name": "concise",
      "label": "Concise",
      "description": "One sentence describing the approach",
      "prompt": "the full prompt text"
    },
    {
      "name": "socratic",
      "label": "Socratic",
      "description": "One sentence describing the approach",
      "prompt": "the full prompt text"
    }
  ]
}`

async function walkVault(path) {
  const items = await listVault(path)
  const allFiles = items.files || []
  const files = allFiles.filter(f => !f.endsWith('/') && f.endsWith('.md')).map(f => path + f)
  const folders = allFiles.filter(f => f.endsWith('/')).map(f => f.slice(0, -1))
  const nested = await Promise.all(folders.map(folder => walkVault(path + folder + '/')))
  return [...files, ...nested.flat()]
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

function WinRate({ wins, runs }) {
  if (!runs) return <span style={{ color: 'var(--forge-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem' }}>no races</span>
  const pct = Math.round((wins / runs) * 100)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <div style={{ width: '60px', height: '4px', background: 'var(--forge-border)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--forge-accent)', borderRadius: '2px', transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem', color: 'var(--forge-accent)' }}>{pct}%</span>
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.58rem', color: 'var(--forge-muted)' }}>{wins}/{runs}</span>
    </div>
  )
}

export function Variants({ navigateTo }) {
  const [basePrompts, setBasePrompts] = useState([])
  const [selectedBase, setSelectedBase] = useState(null)
  const [variants, setVariants] = useState([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)

  const [raceContext, setRaceContext] = useState('')
  const [racing, setRacing] = useState(false)
  const [outputs, setOutputs] = useState({})
  const [voted, setVoted] = useState(null)
  const [raceComplete, setRaceComplete] = useState(false)
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
          return { path, raw, slug, title: fm.title || slug, category: fm.category || 'other', body: stripFrontmatter(raw).trim() }
        } catch { return null }
      }))
      setBasePrompts(entries.filter(Boolean))
    } catch (e) { setError(e.message) }
    setLoading(false)
  }, [])

  useEffect(() => { loadBase() }, [loadBase])

  const loadVariants = useCallback(async (slug) => {
    try {
      const variantPath = `prompts/_variants/${slug}/`
      let items
      try { items = await listVault(variantPath) }
      catch { setVariants([]); return }
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
            path: `${variantPath}${f}`,
            raw,
          }
        } catch { return null }
      }))
      setVariants(loaded.filter(Boolean))
    } catch { setVariants([]) }
  }, [])

  const handleSelectBase = (p) => {
    setSelectedBase(p)
    setOutputs({})
    setVoted(null)
    setRaceComplete(false)
    setRaceContext('')
    setError(null)
    loadVariants(p.slug)
  }

  const handleGenerate = async () => {
    if (!selectedBase) return
    setGenerating(true)
    setError(null)
    try {
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
          messages: [{ role: 'user', content: `Base prompt:\n\n${selectedBase.body}` }]
        })
      })
      const data = await res.json()
      const text = data.content?.[0]?.text || ''
      const clean = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)
      await Promise.all(parsed.variants.map(async v => {
        const fm = `---
label: ${v.label}
description: ${v.description}
base: ${selectedBase.slug}
wins: 0
runs: 0
---

${v.prompt.trim()}
`
        await writeFile(`prompts/_variants/${selectedBase.slug}/${v.name}.md`, fm)
      }))
      await loadVariants(selectedBase.slug)
    } catch (e) { setError(`Generation failed: ${e.message}`) }
    setGenerating(false)
  }

  const handleRace = async () => {
    if (!variants.length || racing) return
    setRacing(true)
    setOutputs({})
    setVoted(null)
    setRaceComplete(false)
    await Promise.all(variants.map(async v => {
      try {
        await runPrompt({
          system: v.body,
          user: raceContext || 'Begin.',
          temperature: 0.7,
          onChunk: (chunk, full) => {
            setOutputs(prev => ({ ...prev, [v.name]: full }))
            if (outputRefs.current[v.name]) {
              outputRefs.current[v.name].scrollTop = outputRefs.current[v.name].scrollHeight
            }
          }
        })
      } catch (e) {
        setOutputs(prev => ({ ...prev, [v.name]: `Error: ${e.message}` }))
      }
    }))
    setRacing(false)
    setRaceComplete(true)
  }

  const handleVote = async (winnerName) => {
    if (voted) return
    setVoted(winnerName)
    await Promise.all(variants.map(async v => {
      const isWinner = v.name === winnerName
      const fm = parseFrontmatter(v.raw)
      const newWins = parseInt(fm.wins || '0') + (isWinner ? 1 : 0)
      const newRuns = parseInt(fm.runs || '0') + 1
      const newFm = `---
label: ${fm.label || v.label}
description: ${fm.description || v.description}
base: ${selectedBase.slug}
wins: ${newWins}
runs: ${newRuns}
---

${v.body}
`
      await writeFile(v.path, newFm)
    }))
    await loadVariants(selectedBase.slug)
  }

  const winner = voted ? variants.find(v => v.name === voted) : null
  const hasOutputs = Object.keys(outputs).length > 0

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 52px)', overflow: 'hidden' }}>

      {/* Left panel */}
      <div style={{ width: '260px', minWidth: '260px', borderRight: '1px solid var(--forge-border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--forge-border)', background: 'var(--forge-surface)' }}>
          <Label>base prompt</Label>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-muted)', marginTop: '2px' }}>
            {loading ? '…' : `${basePrompts.length} prompts`}
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {basePrompts.map(p => (
            <div key={p.path} onClick={() => handleSelectBase(p)} style={{
              padding: '10px 14px', cursor: 'pointer',
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
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem', color: 'var(--forge-muted)' }}>
            select a base prompt
          </div>
        ) : (
          <>
            {/* Header */}
            <div style={{ borderBottom: '1px solid var(--forge-border)', padding: '10px 16px', background: 'var(--forge-surface)', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.9rem', color: 'var(--forge-text)' }}>{selectedBase.title}</div>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem', color: 'var(--forge-muted)', marginTop: '2px' }}>
                  {variants.length} variant{variants.length !== 1 ? 's' : ''}
                </div>
              </div>
              <button onClick={handleGenerate} disabled={generating} style={{
                background: generating ? 'var(--forge-surface)' : variants.length ? 'none' : 'var(--forge-accent)',
                border: `1px solid ${generating ? 'var(--forge-border)' : variants.length ? 'var(--forge-border)' : 'transparent'}`,
                color: generating ? 'var(--forge-muted)' : variants.length ? 'var(--forge-muted)' : '#000',
                fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem',
                padding: '6px 14px', cursor: generating ? 'default' : 'pointer', borderRadius: '4px',
              }}>{generating ? '◌ generating…' : variants.length ? '↻ regenerate' : '⚡ generate variants'}</button>
            </div>

            {error && <div style={{ padding: '8px 16px', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem', color: 'var(--forge-red)', borderBottom: '1px solid var(--forge-border)' }}>{error}</div>}

            {variants.length === 0 ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem', color: 'var(--forge-muted)' }}>no variants yet</div>
                <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '0.78rem', color: 'var(--forge-border-bright)', maxWidth: '300px', textAlign: 'center', lineHeight: 1.6 }}>
                  click ⚡ generate variants — Claude will create 3 distinct approaches and save them to your vault
                </div>
              </div>
            ) : (
              <>
                {/* Leaderboard — shown when not racing */}
                {!hasOutputs && (
                  <div style={{ padding: '16px', borderBottom: '1px solid var(--forge-border)' }}>
                    <Label>leaderboard — {variants.reduce((s, v) => s + v.runs, 0)} races run</Label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                      {[...variants].sort((a, b) => {
                        const ar = a.runs ? a.wins / a.runs : -1
                        const br = b.runs ? b.wins / b.runs : -1
                        return br - ar
                      }).map((v, i) => (
                        <div key={v.name} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 12px', background: 'var(--forge-surface)', borderRadius: '4px', border: '1px solid var(--forge-border)' }}>
                          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: i === 0 && v.runs > 0 ? 'var(--forge-accent)' : 'var(--forge-border-bright)', width: '16px' }}>
                            {i === 0 && v.runs > 0 ? '★' : `${i + 1}.`}
                          </span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontFamily: 'Syne, sans-serif', fontWeight: 600, fontSize: '0.78rem', color: 'var(--forge-text)' }}>{v.label}</div>
                            <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '0.68rem', color: 'var(--forge-muted)', marginTop: '1px' }}>{v.description}</div>
                          </div>
                          <WinRate wins={v.wins} runs={v.runs} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Race setup — shown when not racing */}
                {!hasOutputs && (
                  <div style={{ padding: '16px', borderBottom: '1px solid var(--forge-border)', display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                      <Label>race context — same input runs through all {variants.length} variants simultaneously</Label>
                      <textarea
                        value={raceContext}
                        onChange={e => setRaceContext(e.target.value)}
                        placeholder="Paste the context you want to test against (company name, meeting notes, topic, etc.)…"
                        style={{
                          width: '100%', background: 'var(--forge-surface)', border: '1px solid var(--forge-border)',
                          color: 'var(--forge-text)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem',
                          padding: '8px', borderRadius: '4px', outline: 'none', resize: 'vertical',
                          lineHeight: 1.6, minHeight: '60px',
                        }}
                      />
                    </div>
                    <button onClick={handleRace} disabled={racing} style={{
                      background: racing ? 'var(--forge-surface)' : 'var(--forge-accent)',
                      border: 'none', color: racing ? 'var(--forge-muted)' : '#000',
                      fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.85rem',
                      padding: '10px 20px', cursor: racing ? 'default' : 'pointer', borderRadius: '4px',
                      letterSpacing: '0.05em', whiteSpace: 'nowrap',
                    }}>{racing ? '● racing…' : '▶ race all'}</button>
                  </div>
                )}

                {/* Race outputs */}
                {hasOutputs && (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

                    {/* Status / next step bar */}
                    <div style={{
                      padding: '10px 16px',
                      borderBottom: '1px solid var(--forge-border)',
                      background: voted
                        ? 'color-mix(in srgb, var(--forge-accent) 10%, var(--forge-surface))'
                        : 'var(--forge-surface)',
                      display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
                    }}>
                      {!raceComplete && !voted && (
                        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-accent)' }}>
                          ● streaming all variants…
                        </span>
                      )}

                      {raceComplete && !voted && (
                        <>
                          <span style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.82rem', color: 'var(--forge-text)' }}>
                            Which output is best?
                          </span>
                          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-muted)' }}>
                            Click a column header to vote — wins are tracked over time
                          </span>
                        </>
                      )}

                      {voted && winner && (
                        <>
                          <span style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.85rem', color: 'var(--forge-accent)' }}>
                            ★ {winner.label} wins
                          </span>
                          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-muted)' }}>
                            {winner.wins}/{winner.runs} races · {Math.round((winner.wins / winner.runs) * 100)}% win rate
                          </span>
                          <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
                            <button
                              onClick={handleRace}
                              style={{
                                background: 'none', border: '1px solid var(--forge-border)',
                                color: 'var(--forge-muted)', fontFamily: 'JetBrains Mono, monospace',
                                fontSize: '0.65rem', padding: '5px 12px', cursor: 'pointer', borderRadius: '4px',
                              }}
                            >▶ race again</button>
                            <button
                              onClick={() => navigateTo('runner')}
                              style={{
                                background: 'var(--forge-accent)', border: 'none', color: '#000',
                                fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.78rem',
                                padding: '5px 16px', cursor: 'pointer', borderRadius: '4px',
                                letterSpacing: '0.03em',
                              }}
                            >Use in Runner →</button>
                          </div>
                        </>
                      )}
                    </div>

                    {/* Side by side outputs */}
                    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                      {variants.map((v, i) => {
                        const isWinner = voted === v.name
                        const isLoser = voted && voted !== v.name
                        return (
                          <div key={v.name} style={{
                            flex: 1, display: 'flex', flexDirection: 'column',
                            borderRight: i < variants.length - 1 ? '1px solid var(--forge-border)' : 'none',
                            overflow: 'hidden',
                            opacity: isLoser ? 0.4 : 1,
                            transition: 'opacity 0.3s',
                          }}>
                            {/* Column header — click to vote */}
                            <div
                              onClick={() => raceComplete && !voted && handleVote(v.name)}
                              style={{
                                padding: '8px 14px',
                                background: isWinner
                                  ? 'color-mix(in srgb, var(--forge-accent) 15%, var(--forge-surface))'
                                  : 'var(--forge-surface)',
                                borderBottom: `1px solid ${isWinner ? 'var(--forge-accent)' : 'var(--forge-border)'}`,
                                cursor: raceComplete && !voted ? 'pointer' : 'default',
                                display: 'flex', alignItems: 'center', gap: '8px',
                                transition: 'background 0.2s',
                              }}
                            >
                              <div style={{ flex: 1 }}>
                                <div style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.78rem', color: isWinner ? 'var(--forge-accent)' : 'var(--forge-text)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  {isWinner && <span>★</span>}
                                  {v.label}
                                </div>
                                <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '0.65rem', color: 'var(--forge-muted)' }}>{v.description}</div>
                              </div>
                              {raceComplete && !voted && (
                                <span style={{
                                  fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
                                  color: 'var(--forge-accent)', border: '1px solid var(--forge-accent)',
                                  padding: '2px 8px', borderRadius: '3px',
                                }}>vote ↑</span>
                              )}
                              <WinRate wins={v.wins} runs={v.runs} />
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
          </>
        )}
      </div>
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.4 } }`}</style>
    </div>
  )
}
