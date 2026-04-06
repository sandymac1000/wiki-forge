import { useState, useRef } from 'react'
import { writeFile, readFile } from '../lib/obsidian.js'

const WIKI_CLASSIFIER_PROMPT = `You are a knowledge base librarian for a venture capital wiki. Analyse the content provided and return ONLY a JSON object with no preamble, no markdown, no backticks.

Return exactly this structure:
{
  "title": "Descriptive title (3-8 words)",
  "slug": "kebab-case-slug",
  "source_type": "report|article|transcript|thread|email|notes|data|research",
  "wiki_section": "summaries|entities|concepts|comparisons|query-results",
  "description": "One sentence TLDR describing what this content covers",
  "tags": ["tag1", "tag2", "tag3"],
  "key_entities": ["Company or Person Name"],
  "suggested_path": "wiki/[wiki_section]/[slug].md"
}

wiki_section rules — pick the single best fit:
- summaries: source documents (articles, reports, papers, transcripts, threads, emails)
- entities: content primarily about ONE company, person, fund, or technology
- concepts: mental models, frameworks, investment theses, recurring ideas
- comparisons: head-to-head analysis of two or more specific things
- query-results: answers to specific questions worth preserving as reference

Use tags that are useful for a VC: e.g. ai, deep-tech, pre-seed, seed, spinout, due-diligence, board, portfolio, market-research, founder, competitor`

const TODAY = new Date().toISOString().split('T')[0]

const SOURCE_TYPE_LABELS = {
  report: 'Report / Whitepaper',
  article: 'Article / Blog',
  transcript: 'Transcript / Meeting',
  thread: 'Thread / Social',
  email: 'Email',
  notes: 'Notes',
  data: 'Data / Spreadsheet',
  research: 'Research Paper',
}

export function WikiIngest() {
  const [inputMode, setInputMode] = useState('paste') // paste | url | file
  const [pasteText, setPasteText] = useState('')
  const [urlValue, setUrlValue] = useState('')
  const [fileName, setFileName] = useState(null)
  const [fileBase64, setFileBase64] = useState(null)
  const [converting, setConverting] = useState(false)
  const [converted, setConverted] = useState(null) // { markdown, detected_type }
  const [classifying, setClassifying] = useState(false)
  const [proposal, setProposal] = useState(null)
  const [editPath, setEditPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)
  const fileRef = useRef()

  const reset = () => {
    setPasteText(''); setUrlValue(''); setFileName(null); setFileBase64(null)
    setConverted(null); setProposal(null); setEditPath(''); setSaved(false); setError(null)
  }

  // ── Step 1: Convert input to markdown ──────────────────────────────────────

  const handleConvert = async () => {
    setConverting(true); setError(null); setProposal(null); setSaved(false)
    try {
      let result
      if (inputMode === 'paste') {
        result = { markdown: pasteText.trim(), detected_type: 'notes' }
      } else if (inputMode === 'url') {
        const res = await fetch('/convert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'url', url: urlValue.trim() }),
        })
        if (!res.ok) throw new Error(`Convert failed: ${res.status}`)
        result = await res.json()
        if (result.error) throw new Error(result.error)
      } else if (inputMode === 'file' && fileBase64) {
        const res = await fetch('/convert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'file', filename: fileName, content_base64: fileBase64 }),
        })
        if (!res.ok) throw new Error(`Convert failed: ${res.status}`)
        result = await res.json()
        if (result.error) throw new Error(result.error)
      } else {
        throw new Error('No input provided')
      }
      setConverted(result)
      await classify(result.markdown)
    } catch (e) {
      setError(e.message)
    }
    setConverting(false)
  }

  // ── Step 2: Classify with Claude ───────────────────────────────────────────

  const classify = async (markdown) => {
    setClassifying(true)
    try {
      const preview = markdown.slice(0, 4000)
      const res = await fetch('/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': import.meta.env.VITE_ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 600,
          messages: [{
            role: 'user',
            content: `${WIKI_CLASSIFIER_PROMPT}\n\nContent to classify:\n\n${preview}`,
          }],
        }),
      })
      const data = await res.json()
      const text = data.content?.[0]?.text || ''
      const clean = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(clean)
      const slug = `${TODAY}-${parsed.slug}`
      const path = `wiki/${parsed.wiki_section}/${slug}.md`
      setProposal({ ...parsed, slug })
      setEditPath(path)
    } catch (e) {
      setError(`Classification failed: ${e.message}`)
    }
    setClassifying(false)
  }

  // ── Step 3: Save to vault ──────────────────────────────────────────────────

  const handleSave = async () => {
    if (!proposal || !converted) return
    setSaving(true)
    try {
      const source = inputMode === 'url' ? urlValue : (fileName || 'pasted content')
      const typeMap = {
        summaries: 'summary', entities: 'entity', concepts: 'concept',
        comparisons: 'comparison', 'query-results': 'query-result',
      }
      const pageType = typeMap[proposal.wiki_section] || 'summary'
      const tagsYaml = (proposal.tags || []).map(t => `  - ${t}`).join('\n')
      const entitiesYaml = (proposal.key_entities || []).map(e => `  - "${e}"`).join('\n')

      const page = `---
title: "${proposal.title}"
type: ${pageType}
sources:
  - "${source}"
created: ${TODAY}
updated: ${TODAY}
tags:
${tagsYaml}
---

**TLDR:** ${proposal.description}

---

${converted.markdown.trim()}
`
      await writeFile(editPath, page)

      // Append to log.md
      await appendToLog(proposal.title, proposal.wiki_section, source)

      // Update INDEX.md
      await appendToIndex(proposal.title, editPath, proposal.description, source)

      setSaved(true)
    } catch (e) {
      setError(`Save failed: ${e.message}`)
    }
    setSaving(false)
  }

  const appendToLog = async (title, section, source) => {
    try {
      let log = ''
      try { log = await readFile('wiki/log.md') } catch {}
      const entry = `\n## [${TODAY}] ingest | ${title}\n\nSection: ${section} | Source: ${source}\n`
      await writeFile('wiki/log.md', log + entry)
    } catch {}
  }

  const appendToIndex = async (title, path, tldr, source) => {
    try {
      let index = await readFile('wiki/INDEX.md')
      const sectionMap = {
        'summaries': '## Summaries', 'entities': '## Entities',
        'concepts': '## Concepts', 'comparisons': '## Comparisons',
        'query-results': '## Query Results',
      }
      const section = proposal?.wiki_section
      const header = sectionMap[section]
      const row = `| [${title}](${path}) | ${tldr} | 1 | ${TODAY} |`
      if (header && index.includes(header)) {
        // Insert after the table header row (the | --- | line)
        const headerIdx = index.indexOf(header)
        const afterHeader = index.indexOf('\n|---', headerIdx)
        if (afterHeader > -1) {
          const lineEnd = index.indexOf('\n', afterHeader + 1)
          index = index.slice(0, lineEnd + 1) + row + '\n' + index.slice(lineEnd + 1)
        }
      }
      // Update total count line
      const countMatch = index.match(/Total pages: (\d+)/)
      if (countMatch) {
        index = index.replace(countMatch[0], `Total pages: ${parseInt(countMatch[1]) + 1}`)
      }
      index = index.replace(/Last updated: [\d-]+/, `Last updated: ${TODAY}`)
      await writeFile('wiki/INDEX.md', index)
    } catch {}
  }

  // ── File picker ────────────────────────────────────────────────────────────

  const handleFilePick = (e) => {
    const file = e.target.files[0]
    if (!file) return
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (ev) => setFileBase64(ev.target.result.split(',')[1])
    reader.readAsDataURL(file)
  }

  const canConvert = (
    (inputMode === 'paste' && pasteText.trim()) ||
    (inputMode === 'url' && urlValue.trim()) ||
    (inputMode === 'file' && fileBase64)
  )

  const isWorking = converting || classifying

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 52px)', overflow: 'hidden' }}>

      {/* Left — input */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--forge-border)', padding: '20px' }}>

        {/* Mode selector */}
        <div style={{ display: 'flex', gap: '0', marginBottom: '16px', border: '1px solid var(--forge-border)', borderRadius: '4px', overflow: 'hidden' }}>
          {[['paste', '⌨ Paste'], ['url', '⊕ URL'], ['file', '▲ File']].map(([mode, label]) => (
            <button key={mode} onClick={() => { setInputMode(mode); reset() }} style={{
              flex: 1, background: inputMode === mode ? 'var(--forge-accent)' : 'var(--forge-surface)',
              border: 'none', color: inputMode === mode ? '#000' : 'var(--forge-muted)',
              fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem',
              padding: '8px', cursor: 'pointer', letterSpacing: '0.05em',
            }}>{label}</button>
          ))}
        </div>

        {/* Input area */}
        {inputMode === 'paste' && (
          <textarea
            value={pasteText}
            onChange={e => { setPasteText(e.target.value); setProposal(null); setSaved(false) }}
            placeholder={`Paste any content here — article text, meeting notes, email thread, research summary, unstructured thoughts…\n\nClaude will classify it and file it into the right part of your wiki.`}
            style={textareaStyle}
          />
        )}

        {inputMode === 'url' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
            <input
              value={urlValue}
              onChange={e => { setUrlValue(e.target.value); setProposal(null); setSaved(false) }}
              placeholder="https://..."
              style={{ ...fieldStyle, padding: '10px 12px', fontSize: '0.82rem' }}
            />
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.68rem', color: 'var(--forge-muted)', lineHeight: 1.8 }}>
              Fetches the page and converts to markdown.<br />
              Works with articles, blog posts, research papers, arXiv, bioRxiv, PubMed.
            </div>
          </div>
        )}

        {inputMode === 'file' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: 1 }}>
            <div
              onClick={() => fileRef.current?.click()}
              style={{
                border: `2px dashed ${fileName ? 'var(--forge-accent)' : 'var(--forge-border)'}`,
                borderRadius: '6px', padding: '40px 20px', textAlign: 'center',
                cursor: 'pointer', flex: 1, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: '8px',
                background: 'var(--forge-surface)',
              }}
            >
              <div style={{ fontSize: '2rem' }}>{fileName ? '✓' : '▲'}</div>
              <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem', color: fileName ? 'var(--forge-accent)' : 'var(--forge-muted)' }}>
                {fileName || 'click to select file'}
              </div>
              {!fileName && (
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem', color: 'var(--forge-muted)', marginTop: '4px' }}>
                  PDF · DOCX · PPTX · XLSX · MD · TXT
                </div>
              )}
            </div>
            <input ref={fileRef} type="file" accept=".pdf,.docx,.pptx,.xlsx,.xls,.md,.txt,.html" onChange={handleFilePick} style={{ display: 'none' }} />
            {fileName && (
              <button onClick={() => { setFileName(null); setFileBase64(null); setProposal(null) }} style={ghostBtn}>
                × remove
              </button>
            )}
          </div>
        )}

        {error && (
          <div style={{ color: 'var(--forge-red)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem', marginTop: '8px', padding: '8px', background: 'var(--forge-surface)', borderRadius: '4px' }}>
            {error}
          </div>
        )}

        <button
          onClick={handleConvert}
          disabled={!canConvert || isWorking}
          style={{
            marginTop: '12px',
            background: isWorking ? 'var(--forge-surface)' : (canConvert ? 'var(--forge-accent)' : 'var(--forge-surface)'),
            border: 'none', color: isWorking ? 'var(--forge-muted)' : (canConvert ? '#000' : 'var(--forge-muted)'),
            fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.9rem',
            padding: '12px', cursor: !canConvert || isWorking ? 'default' : 'pointer',
            borderRadius: '4px', letterSpacing: '0.05em',
          }}
        >
          {converting ? '◌ converting…' : classifying ? '◌ classifying…' : '⚡ convert + classify'}
        </button>
      </div>

      {/* Right — classification proposal */}
      <div style={{ width: '400px', minWidth: '400px', padding: '20px', overflow: 'auto' }}>
        <Label>wiki classification</Label>

        {!proposal && !error && (
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem', color: 'var(--forge-muted)', marginTop: '12px', lineHeight: 1.9 }}>
            provide content and click convert + classify<br /><br />
            claude will propose:<br />
            • wiki section (summaries / entities / concepts…)<br />
            • source type (report / transcript / article…)<br />
            • title, tags, key entities<br />
            • save path in the vault
          </div>
        )}

        {proposal && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '8px' }}>

            <Field label="title" value={proposal.title} onChange={v => setProposal(p => ({ ...p, title: v }))} />

            <div style={{ display: 'flex', gap: '8px' }}>
              <div style={{ flex: 1 }}>
                <Label>wiki section</Label>
                <select value={proposal.wiki_section} onChange={e => {
                  const s = e.target.value
                  setProposal(p => ({ ...p, wiki_section: s }))
                  setEditPath(`wiki/${s}/${TODAY}-${proposal.slug}.md`)
                }} style={{ ...fieldStyle, width: '100%' }}>
                  {['summaries','entities','concepts','comparisons','query-results'].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <Label>source type</Label>
                <select value={proposal.source_type} onChange={e => setProposal(p => ({ ...p, source_type: e.target.value }))} style={{ ...fieldStyle, width: '100%' }}>
                  {Object.entries(SOURCE_TYPE_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>
            </div>

            <Field label="TLDR / description" value={proposal.description} onChange={v => setProposal(p => ({ ...p, description: v }))} />

            <div>
              <Label>tags</Label>
              <input
                value={(proposal.tags || []).join(', ')}
                onChange={e => setProposal(p => ({ ...p, tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) }))}
                style={{ ...fieldStyle, width: '100%' }}
                placeholder="ai, deep-tech, portfolio..."
              />
            </div>

            <div>
              <Label>key entities</Label>
              <input
                value={(proposal.key_entities || []).join(', ')}
                onChange={e => setProposal(p => ({ ...p, key_entities: e.target.value.split(',').map(t => t.trim()).filter(Boolean) }))}
                style={{ ...fieldStyle, width: '100%' }}
                placeholder="Company A, Person B..."
              />
            </div>

            <div>
              <Label>save path in vault</Label>
              <input value={editPath} onChange={e => setEditPath(e.target.value)} style={{ ...fieldStyle, width: '100%' }} />
            </div>

            {converted && (
              <div>
                <Label>converted markdown preview</Label>
                <div style={{
                  background: 'var(--forge-surface)', border: '1px solid var(--forge-border)',
                  borderRadius: '4px', padding: '10px', maxHeight: '120px', overflow: 'auto',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem',
                  color: 'var(--forge-muted)', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                }}>
                  {converted.markdown.slice(0, 500)}{converted.markdown.length > 500 ? '\n…' : ''}
                </div>
              </div>
            )}

            <button
              onClick={handleSave}
              disabled={saving || saved}
              style={{
                marginTop: '4px',
                background: saved ? 'var(--forge-green)' : 'var(--forge-accent)',
                border: 'none', color: '#000',
                fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.85rem',
                padding: '10px', cursor: saving || saved ? 'default' : 'pointer',
                borderRadius: '4px', letterSpacing: '0.05em', opacity: saving ? 0.7 : 1,
              }}
            >{saved ? '✓ saved to wiki' : saving ? 'saving…' : '▼ save to wiki'}</button>

            {saved && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-muted)' }}>
                  ↳ {editPath}<br />
                  ↳ log.md updated<br />
                  ↳ INDEX.md updated
                </div>
                <button onClick={reset} style={{ ...ghostBtn, padding: '8px' }}>+ ingest another</button>
              </div>
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
      <input value={value} onChange={e => onChange(e.target.value)} style={{ ...fieldStyle, width: '100%' }} />
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

const textareaStyle = {
  flex: 1, background: 'var(--forge-surface)', border: '1px solid var(--forge-border)',
  color: 'var(--forge-text)', fontFamily: 'JetBrains Mono, monospace',
  fontSize: '0.78rem', lineHeight: 1.7, padding: '16px', borderRadius: '4px',
  outline: 'none', resize: 'none',
}

const fieldStyle = {
  background: 'var(--forge-surface)', border: '1px solid var(--forge-border)',
  color: 'var(--forge-text)', fontFamily: 'JetBrains Mono, monospace',
  fontSize: '0.7rem', padding: '6px 8px', borderRadius: '4px', outline: 'none',
}

const ghostBtn = {
  background: 'none', border: '1px solid var(--forge-border)',
  color: 'var(--forge-muted)', fontFamily: 'JetBrains Mono, monospace',
  fontSize: '0.7rem', padding: '3px 10px', cursor: 'pointer', borderRadius: '3px', width: '100%',
}
