import { useState, useEffect, useCallback } from 'react'
import { listVault, readFile, writeFile, parseFrontmatter, stripFrontmatter } from '../lib/obsidian.js'

const IMPROVE_SYSTEM = `You are an expert prompt engineer. You will be given a prompt template and feedback about how it performed (rating out of 5 and notes from the user).

Your job is to propose a specific, improved version of the prompt that addresses the feedback.

Return ONLY a JSON object with no preamble, no markdown, no backticks:
{
  "reasoning": "2-3 sentences explaining what you changed and why, directly addressing the feedback",
  "proposed": "the full improved prompt text (no frontmatter, just the prompt body)"
}`

async function walkVault(path) {
  const items = await listVault(path)
  const allFiles = items.files || []
  const files = allFiles.filter(f => !f.endsWith('/') && f.endsWith('.md')).map(f => path + f)
  const folders = allFiles.filter(f => f.endsWith('/')).map(f => f.slice(0, -1))
  const nested = await Promise.all(folders.map(folder => walkVault(path + folder + '/')))
  return [...files, ...nested.flat()]
}

function diffLines(original, proposed) {
  const origLines = original.split('\n')
  const propLines = proposed.split('\n')
  const maxLen = Math.max(origLines.length, propLines.length)
  const result = []
  for (let i = 0; i < maxLen; i++) {
    const o = origLines[i] ?? null
    const p = propLines[i] ?? null
    result.push({
      orig: o,
      prop: p,
      changed: o !== p,
      added: o === null,
      removed: p === null,
    })
  }
  return result
}

function DiffPane({ lines, side }) {
  return (
    <div style={{ flex: 1, overflow: 'auto', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem', lineHeight: 1.7 }}>
      {lines.map((l, i) => {
        const text = side === 'orig' ? l.orig : l.prop
        const isChanged = l.changed
        const isMissing = text === null
        return (
          <div key={i} style={{
            padding: '1px 16px',
            background: isMissing
              ? 'color-mix(in srgb, var(--forge-red) 8%, transparent)'
              : isChanged
                ? side === 'orig'
                  ? 'color-mix(in srgb, var(--forge-red) 10%, transparent)'
                  : 'color-mix(in srgb, var(--forge-green) 10%, transparent)'
                : 'transparent',
            color: isMissing
              ? 'var(--forge-border-bright)'
              : isChanged
                ? side === 'orig' ? 'color-mix(in srgb, var(--forge-red) 80%, var(--forge-text))' : 'color-mix(in srgb, var(--forge-green) 80%, var(--forge-text))'
                : 'var(--forge-text)',
            borderLeft: isChanged
              ? `2px solid ${side === 'orig' ? 'var(--forge-red)' : 'var(--forge-green)'}`
              : '2px solid transparent',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            minHeight: '1.7em',
          }}>
            {isMissing ? '' : (text || ' ')}
          </div>
        )
      })}
    </div>
  )
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

export function Improvements() {
  const [prompts, setPrompts] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [proposing, setProposing] = useState(false)
  const [proposal, setProposal] = useState(null) // { reasoning, proposed }
  const [editMode, setEditMode] = useState(false)
  const [editedProposed, setEditedProposed] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  const loadPrompts = useCallback(async () => {
    setLoading(true)
    try {
      const paths = await walkVault('prompts/')
      const filtered = paths.filter(p => !p.includes('/_context/') && !p.includes('/_archive/'))
      const entries = await Promise.all(
        filtered.map(async (path) => {
          try {
            const raw = await readFile(path)
            const fm = parseFrontmatter(raw)
            const rating = fm.rating && fm.rating !== 'null' ? parseInt(fm.rating) : null
            const notes = fm.notes && fm.notes !== '""' ? fm.notes.replace(/^"|"$/g, '') : null
            if (!rating || rating === 5) return null // exclude unrated and perfect scores
            return {
              path, raw,
              title: fm.title || path.split('/').pop().replace('.md', ''),
              category: fm.category || 'other',
              rating,
              notes,
              version: fm.version || '1',
              body: stripFrontmatter(raw).trim(),
            }
          } catch { return null }
        })
      )
      const rated = entries.filter(Boolean).sort((a, b) => a.rating - b.rating) // worst first
      setPrompts(rated)
      if (rated.length > 0 && !selected) setSelected(rated[0])
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadPrompts() }, [loadPrompts])

  const handleSelect = async (p) => {
    setSelected(p)
    setProposal(null)
    setEditMode(false)
    setSaved(false)
    setError(null)
  }

  const handlePropose = async () => {
    if (!selected) return
    setProposing(true)
    setProposal(null)
    setError(null)
    setSaved(false)

    try {
      const userMsg = `## Prompt to improve\n\n${selected.body}\n\n## Performance feedback\nRating: ${selected.rating}/5\nNotes: ${selected.notes || 'No notes provided'}`

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
          max_tokens: 2000,
          system: IMPROVE_SYSTEM,
          messages: [{ role: 'user', content: userMsg }]
        })
      })

      const data = await res.json()
      const text = data.content?.[0]?.text || ''
      const clean = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)
      setProposal(parsed)
      setEditedProposed(parsed.proposed)
      setEditMode(false)
    } catch (e) {
      setError(`Proposal failed: ${e.message}`)
    }
    setProposing(false)
  }

  const handleApprove = async () => {
    if (!selected || !proposal) return
    setSaving(true)
    try {
      const fm = parseFrontmatter(selected.raw)
      const newVersion = parseInt(selected.version || '1') + 1

      // Archive original
      const archivePath = `prompts/_archive/${selected.path.split('/').pop().replace('.md', '')}-v${selected.version}.md`
      await writeFile(archivePath, selected.raw)

      // Write improved version
      const finalBody = editMode ? editedProposed : proposal.proposed
      const newFm = `---
title: ${fm.title || ''}
category: ${fm.category || 'other'}
subcategory: ${fm.subcategory || ''}
params: ${fm.params || ''}
description: ${fm.description || ''}
version: ${newVersion}
rating: null
last_used: null
notes: ""
improvement_note: "${proposal.reasoning.replace(/"/g, "'")}"
---

${finalBody.trim()}
`
      await writeFile(selected.path, newFm)
      setSaved(true)

      // Refresh list and deselect
      setTimeout(() => {
        loadPrompts()
        setProposal(null)
        setSaved(false)
      }, 2000)
    } catch (e) {
      setError(`Save failed: ${e.message}`)
    }
    setSaving(false)
  }

  const diffed = proposal ? diffLines(selected?.body || '', editMode ? editedProposed : proposal.proposed) : null
  const changedCount = diffed ? diffed.filter(l => l.changed).length : 0

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 52px)', overflow: 'hidden' }}>

      {/* Left panel — rated prompt list */}
      <div style={{
        width: '260px', minWidth: '260px',
        borderRight: '1px solid var(--forge-border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--forge-border)', background: 'var(--forge-surface)' }}>
          <Label>rated prompts</Label>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-muted)', marginTop: '2px' }}>
            {loading ? '…' : `${prompts.length} with ratings • worst first`}
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading ? (
            <div style={{ padding: '16px', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-muted)' }}>loading…</div>
          ) : prompts.length === 0 ? (
            <div style={{ padding: '16px', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-muted)', lineHeight: 1.7 }}>
              no rated prompts yet<br />
              run prompts in Runner<br />
              and rate their outputs
            </div>
          ) : (
            prompts.map(p => (
              <div
                key={p.path}
                onClick={() => handleSelect(p)}
                style={{
                  padding: '10px 14px',
                  cursor: 'pointer',
                  borderBottom: '1px solid var(--forge-border)',
                  borderLeft: selected?.path === p.path ? '2px solid var(--forge-accent)' : '2px solid transparent',
                  background: selected?.path === p.path ? 'color-mix(in srgb, var(--forge-accent) 6%, var(--forge-bg))' : 'transparent',
                  transition: 'all 0.1s',
                }}
              >
                <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '0.75rem', color: 'var(--forge-text)', fontWeight: 500, marginBottom: '4px' }}>
                  {p.title}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <RatingBar rating={p.rating} />
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem', color: 'var(--forge-muted)' }}>v{p.version}</span>
                  {p.notes && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.58rem', color: 'var(--forge-accent-dim)' }}>has notes</span>}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {!selected ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem', color: 'var(--forge-muted)' }}>
            select a rated prompt to improve
          </div>
        ) : (
          <>
            {/* Header */}
            <div style={{
              borderBottom: '1px solid var(--forge-border)',
              padding: '10px 16px',
              background: 'var(--forge-surface)',
              display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.9rem', color: 'var(--forge-text)' }}>{selected.title}</div>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem', color: 'var(--forge-muted)', marginTop: '2px' }}>{selected.path}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <div>
                  <Label>rating</Label>
                  <RatingBar rating={selected.rating} showNum />
                </div>
                {selected.notes && (
                  <div style={{ maxWidth: '300px' }}>
                    <Label>notes</Label>
                    <div style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '0.72rem', color: 'var(--forge-muted)', fontStyle: 'italic' }}>"{selected.notes}"</div>
                  </div>
                )}
                <button
                  onClick={handlePropose}
                  disabled={proposing}
                  style={{
                    background: proposing ? 'var(--forge-surface)' : 'var(--forge-accent)',
                    border: 'none', color: proposing ? 'var(--forge-muted)' : '#000',
                    fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.8rem',
                    padding: '8px 16px', cursor: proposing ? 'default' : 'pointer', borderRadius: '4px',
                    letterSpacing: '0.04em', whiteSpace: 'nowrap',
                  }}
                >{proposing ? '◌ proposing…' : proposal ? '↻ re-propose' : '↑ propose improvement'}</button>
              </div>
            </div>

            {error && (
              <div style={{ padding: '8px 16px', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem', color: 'var(--forge-red)', borderBottom: '1px solid var(--forge-border)' }}>
                {error}
              </div>
            )}

            {/* Content area */}
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

              {!proposal ? (
                /* Original prompt view */
                <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
                  <Label>current prompt — v{selected.version}</Label>
                  <pre style={{
                    fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem',
                    lineHeight: 1.75, color: 'var(--forge-text)',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '8px 0 0',
                  }}>{selected.body}</pre>
                </div>
              ) : (
                /* Diff view */
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

                  {/* Reasoning bar */}
                  <div style={{
                    padding: '10px 16px',
                    background: 'color-mix(in srgb, var(--forge-green) 8%, var(--forge-bg))',
                    borderBottom: '1px solid color-mix(in srgb, var(--forge-green) 20%, transparent)',
                    display: 'flex', alignItems: 'flex-start', gap: '10px',
                  }}>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-green)', whiteSpace: 'nowrap', marginTop: '1px' }}>↑ reasoning</span>
                    <span style={{ fontFamily: 'DM Sans, sans-serif', fontSize: '0.78rem', color: 'var(--forge-text)', lineHeight: 1.6 }}>{proposal.reasoning}</span>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem', color: 'var(--forge-muted)', whiteSpace: 'nowrap', marginLeft: 'auto' }}>
                      {changedCount} line{changedCount !== 1 ? 's' : ''} changed
                    </span>
                  </div>

                  {/* Diff columns */}
                  <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--forge-border)', overflow: 'hidden' }}>
                      <div style={{ padding: '6px 16px', background: 'var(--forge-surface)', borderBottom: '1px solid var(--forge-border)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem', color: 'var(--forge-red)' }}>
                        current — v{selected.version}
                      </div>
                      <DiffPane lines={diffed} side="orig" />
                    </div>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                      <div style={{ padding: '6px 16px', background: 'var(--forge-surface)', borderBottom: '1px solid var(--forge-border)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem', color: 'var(--forge-green)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        proposed — v{parseInt(selected.version) + 1}
                        <button
                          onClick={() => { setEditMode(e => !e); setEditedProposed(proposal.proposed) }}
                          style={{
                            marginLeft: 'auto', background: editMode ? 'var(--forge-accent)' : 'none',
                            border: `1px solid ${editMode ? 'transparent' : 'var(--forge-border)'}`,
                            color: editMode ? '#000' : 'var(--forge-muted)',
                            fontFamily: 'JetBrains Mono, monospace', fontSize: '0.58rem',
                            padding: '2px 7px', cursor: 'pointer', borderRadius: '3px',
                          }}
                        >{editMode ? 'editing' : 'edit'}</button>
                      </div>
                      {editMode ? (
                        <textarea
                          value={editedProposed}
                          onChange={e => setEditedProposed(e.target.value)}
                          style={{
                            flex: 1, background: 'var(--forge-bg)', border: 'none', outline: 'none',
                            color: 'var(--forge-text)', fontFamily: 'JetBrains Mono, monospace',
                            fontSize: '0.72rem', lineHeight: 1.75, padding: '8px 16px', resize: 'none',
                          }}
                        />
                      ) : (
                        <DiffPane lines={diffed} side="prop" />
                      )}
                    </div>
                  </div>

                  {/* Action bar */}
                  <div style={{
                    borderTop: '1px solid var(--forge-border)',
                    padding: '10px 16px',
                    background: 'var(--forge-surface)',
                    display: 'flex', alignItems: 'center', gap: '8px',
                  }}>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem', color: 'var(--forge-muted)', flex: 1 }}>
                      approve archives current to <span style={{ color: 'var(--forge-accent-dim)' }}>prompts/_archive/</span> and bumps to v{parseInt(selected.version) + 1}
                    </span>
                    <button
                      onClick={() => { setProposal(null); setEditMode(false) }}
                      style={{
                        background: 'none', border: '1px solid var(--forge-border)',
                        color: 'var(--forge-muted)', fontFamily: 'JetBrains Mono, monospace',
                        fontSize: '0.7rem', padding: '6px 14px', cursor: 'pointer', borderRadius: '4px',
                      }}
                    >✕ reject</button>
                    <button
                      onClick={handleApprove}
                      disabled={saving || saved}
                      style={{
                        background: saved ? 'var(--forge-green)' : 'var(--forge-accent)',
                        border: 'none', color: '#000',
                        fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.82rem',
                        padding: '6px 20px', cursor: saving || saved ? 'default' : 'pointer', borderRadius: '4px',
                        letterSpacing: '0.04em',
                      }}
                    >{saved ? '✓ approved & archived' : saving ? 'saving…' : '✓ approve'}</button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function RatingBar({ rating, showNum }) {
  const colors = ['', '#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e']
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
      <div style={{ display: 'flex', gap: '2px' }}>
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} style={{
            width: '14px', height: '4px', borderRadius: '2px',
            background: i <= rating ? colors[rating] : 'var(--forge-border)',
            boxShadow: i <= rating ? `0 0 4px ${colors[rating]}` : 'none',
          }} />
        ))}
      </div>
      {showNum && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: colors[rating] }}>{rating}/5</span>}
    </div>
  )
}
