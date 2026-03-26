import { useState } from 'react'
import { writeFile } from '../lib/obsidian.js'

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

export function Inbox() {
  const [raw, setRaw] = useState('')
  const [classifying, setClassifying] = useState(false)
  const [proposal, setProposal] = useState(null)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [editPath, setEditPath] = useState('')

  const handleClassify = async () => {
    if (!raw.trim()) return
    setClassifying(true)
    setProposal(null)
    setError(null)
    setSaved(false)

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
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `${CLASSIFIER_PROMPT}\n\nPrompt to classify:\n\n${raw}`
          }]
        })
      })

      const data = await res.json()
      const text = data.content?.[0]?.text || ''
      const clean = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)
      setProposal(parsed)
      setEditPath(parsed.suggested_path)
    } catch (e) {
      setError(`Classification failed: ${e.message}`)
    }
    setClassifying(false)
  }

  const handleSave = async () => {
    if (!proposal) return
    setSaving(true)
    try {
      const frontmatter = `---
title: ${proposal.title}
category: ${proposal.category}
subcategory: ${proposal.subcategory}
params: ${proposal.params}
description: ${proposal.description}
version: 1
rating: null
last_used: null
notes: ""
---

${raw.trim()}
`
      await writeFile(editPath, frontmatter)
      setSaved(true)
    } catch (e) {
      setError(`Save failed: ${e.message}`)
    }
    setSaving(false)
  }

  const handleClear = () => {
    setRaw('')
    setProposal(null)
    setError(null)
    setSaved(false)
    setEditPath('')
  }

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 52px)', overflow: 'hidden' }}>

      {/* Left — paste area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--forge-border)', padding: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <Label>raw prompt</Label>
          {raw && <button onClick={handleClear} style={ghostBtn}>clear</button>}
        </div>
        <textarea
          value={raw}
          onChange={e => { setRaw(e.target.value); setProposal(null); setSaved(false) }}
          placeholder={`Paste any prompt here — from Twitter, research papers, your own experiments…\n\nClaude will classify it and suggest:\n• title and category\n• params (what context it needs at run time)\n• where to save it in your vault`}
          style={{
            flex: 1, background: 'var(--forge-surface)', border: '1px solid var(--forge-border)',
            color: 'var(--forge-text)', fontFamily: 'JetBrains Mono, monospace',
            fontSize: '0.78rem', lineHeight: 1.7, padding: '16px', borderRadius: '4px',
            outline: 'none', resize: 'none',
          }}
        />
        <button
          onClick={handleClassify}
          disabled={!raw.trim() || classifying}
          style={{
            marginTop: '12px',
            background: classifying ? 'var(--forge-surface)' : 'var(--forge-accent)',
            border: 'none', color: classifying ? 'var(--forge-muted)' : '#000',
            fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.9rem',
            padding: '12px', cursor: !raw.trim() || classifying ? 'default' : 'pointer',
            borderRadius: '4px', letterSpacing: '0.05em',
          }}
        >{classifying ? '◌ classifying…' : '⚡ classify'}</button>
      </div>

      {/* Right — proposal */}
      <div style={{ width: '380px', minWidth: '380px', padding: '20px', overflow: 'auto' }}>
        <Label>classification</Label>

        {error && (
          <div style={{ color: 'var(--forge-red)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem', marginTop: '8px' }}>
            {error}
          </div>
        )}

        {!proposal && !error && (
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem', color: 'var(--forge-muted)', marginTop: '12px', lineHeight: 1.8 }}>
            paste a prompt and click classify<br />
            claude will propose how to file it
          </div>
        )}

        {proposal && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '8px' }}>

            <Field label="title" value={proposal.title} onChange={v => setProposal(p => ({ ...p, title: v }))} />
            <Field label="category" value={proposal.category} onChange={v => setProposal(p => ({ ...p, category: v }))} />
            <Field label="subcategory" value={proposal.subcategory} onChange={v => setProposal(p => ({ ...p, subcategory: v }))} />
            <Field label="params" value={proposal.params} onChange={v => setProposal(p => ({ ...p, params: v }))} />
            <Field label="description" value={proposal.description} onChange={v => setProposal(p => ({ ...p, description: v }))} />

            <div>
              <Label>save path</Label>
              <input
                value={editPath}
                onChange={e => setEditPath(e.target.value)}
                style={{
                  width: '100%', background: 'var(--forge-surface)',
                  border: '1px solid var(--forge-accent-dim)', color: 'var(--forge-text)',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem',
                  padding: '6px 8px', borderRadius: '4px', outline: 'none',
                }}
              />
            </div>

            <button
              onClick={handleSave}
              disabled={saving || saved}
              style={{
                marginTop: '4px',
                background: saved ? 'var(--forge-green)' : 'var(--forge-accent)',
                border: 'none', color: '#000',
                fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.85rem',
                padding: '10px', cursor: saving || saved ? 'default' : 'pointer',
                borderRadius: '4px', letterSpacing: '0.05em',
                opacity: saving ? 0.7 : 1,
              }}
            >{saved ? '✓ saved to vault' : saving ? 'saving…' : '▼ save to vault'}</button>

            {saved && (
              <button onClick={handleClear} style={{ ...ghostBtn, width: '100%', padding: '8px', marginTop: '4px' }}>
                + new prompt
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Field({ label, value, onChange }) {
  return (
    <div>
      <Label>{label}</Label>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: '100%', background: 'var(--forge-surface)',
          border: '1px solid var(--forge-border)', color: 'var(--forge-text)',
          fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem',
          padding: '6px 8px', borderRadius: '4px', outline: 'none',
        }}
      />
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

const ghostBtn = {
  background: 'none', border: '1px solid var(--forge-border)',
  color: 'var(--forge-muted)', fontFamily: 'JetBrains Mono, monospace',
  fontSize: '0.7rem', padding: '3px 10px', cursor: 'pointer', borderRadius: '3px',
}