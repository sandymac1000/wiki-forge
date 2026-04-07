import { useState, useRef, useEffect } from 'react'
import { writeFile, readFile } from '../lib/obsidian.js'
import { loadPersonas, getDefaultPersona, buildPersonaContext } from '../lib/personas.js'
import { Suggestions } from './Suggestions.jsx'

const WIKI_CLASSIFIER_PROMPT = `You are a knowledge base librarian. Analyse the content provided and return ONLY a JSON object with no preamble, no markdown, no backticks.

IMPORTANT: Title, slug, description, and tags must reflect the SUBJECT MATTER — the ideas, people, companies, events, or arguments in the content. Never describe the file format, document type, or technical structure. If the content appears to be mostly raw HTML, CSS, or JavaScript with no readable text, set title to "Unreadable page — JS-rendered or paywalled" and source_type to "article".

Return exactly this structure:
{
  "title": "Subject-matter title capturing the core idea or topic (3-8 words)",
  "slug": "kebab-case-slug",
  "source_type": "report|article|transcript|thread|email|notes|data|research",
  "wiki_section": "summaries|entities|concepts|comparisons|query-results|scheduling",
  "description": "One sentence TLDR of what argument, finding, or insight this content contains",
  "tags": ["topic-tag", "domain-tag", "concept-tag"],
  "key_entities": ["Specific people, companies, funds, or projects mentioned by name"],
  "suggested_path": "wiki/[wiki_section]/[slug].md"
}

wiki_section rules — pick the single best fit:
- summaries: source documents (articles, reports, papers, transcripts, threads, emails)
- entities: content primarily about ONE specific person, organisation, project, or technology
- concepts: mental models, frameworks, recurring ideas, theories
- comparisons: head-to-head analysis of two or more specific things
- query-results: answers to specific questions worth preserving as reference
- scheduling: personal time management, task systems, to-do approaches, calendar and workflow design

Tags should be subject-matter keywords: company names, domains (ai, biotech, climate), concepts (unit-economics, founder-mode, defensibility), not format words like "document" or "webpage".`

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
  const [summarising, setSummarising] = useState(false)
  const [summary, setSummary] = useState(null)
  const [proposal, setProposal] = useState(null)
  const [editPath, setEditPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [savedPath, setSavedPath] = useState(null)
  const [error, setError] = useState(null)
  const [personas, setPersonas] = useState([])
  const [activePersona, setActivePersona] = useState(null)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [connections, setConnections] = useState([])
  const [showConnections, setShowConnections] = useState(false)
  const [linking, setLinking] = useState(false)
  const fileRef = useRef()

  // Load personas from vault on mount
  useEffect(() => {
    loadPersonas().then(loaded => {
      setPersonas(loaded)
      setActivePersona(getDefaultPersona(loaded))
    })
  }, [])

  const reset = () => {
    setPasteText(''); setUrlValue(''); setFileName(null); setFileBase64(null)
    setConverted(null); setProposal(null); setEditPath(''); setSaved(false)
    setSavedPath(null); setError(null); setShowSuggestions(false)
    setSummary(null); setConnections([]); setShowConnections(false); setLinking(false)
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
        result = await res.json()
        if (!res.ok || result.error) throw new Error(result.error || `Convert failed: ${res.status}`)
      } else if (inputMode === 'file' && fileBase64) {
        const res = await fetch('/convert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'file', filename: fileName, content_base64: fileBase64 }),
        })
        result = await res.json()
        if (!res.ok || result.error) throw new Error(result.error || `Convert failed: ${res.status}`)
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
      const personaContext = activePersona ? buildPersonaContext(activePersona) : ''
      const systemNote = personaContext
        ? `${personaContext}\n\nUsing this context to inform classification decisions.\n\n`
        : ''
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
            content: `${systemNote}${WIKI_CLASSIFIER_PROMPT}\n\nContent to classify:\n\n${preview}`,
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

  // ── Step 2b: Summarise with Claude ────────────────────────────────────────

  const summarise = async (markdown, prop) => {
    const personaContext = activePersona ? buildPersonaContext(activePersona) : ''
    const lensLine = personaContext ? `\n\nReviewing through this lens:\n${personaContext}\n` : ''
    const prompt = `You are a knowledge librarian. Write a structured wiki summary of the source document below.${lensLine}

Classification context — title: "${prop.title}", type: ${prop.source_type}, tags: ${(prop.tags || []).join(', ')}.

Write ONLY the markdown body. No frontmatter. Use exactly this structure:

## Key Points
- Specific findings, arguments, or data points (with numbers where available)

## Open Questions
- What does this leave unresolved or worth investigating further?

## Counter-Arguments and Data Gaps
- Strongest critique of the claims made; what evidence is weak or missing

## Key Entities
Brief notes on the most important people, companies, funds, or projects mentioned.

Be specific and analytical. Extract actual claims and numbers. Do not describe the document format — summarise the ideas.

Source document:

${markdown.slice(0, 14000)}`

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
        max_tokens: 1800,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    const data = await res.json()
    if (data.error) throw new Error(data.error.message)
    return data.content?.[0]?.text || ''
  }

  // ── Proposed Connections: find + link ─────────────────────────────────────

  const findConnections = async (prop, savedEditPath) => {
    try {
      const indexText = await readFile('wiki/INDEX.md')
      // Capture full row to match against TLDR as well as title/path
      const rowRegex = /\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|([^|]*)\|[^|]*\|[^|]*\|/g
      const candidates = []
      let match
      while ((match = rowRegex.exec(indexText)) !== null) {
        const title = match[1].trim()
        const path = match[2].trim()
        const tldr = match[3].trim()
        if (path === savedEditPath) continue
        // Match against title + slug + TLDR — catches entities in TLDR but not in title
        const rowText = `${title} ${path} ${tldr}`.toLowerCase()
        const sectionMatch = path.match(/^wiki\/([^/]+)\//)
        const section = sectionMatch ? sectionMatch[1] : 'wiki'
        let reason = null
        // Entity match — min 3 chars to avoid noise
        for (const entity of (prop.key_entities || [])) {
          if (entity && entity.length >= 3 && rowText.includes(entity.toLowerCase())) {
            reason = 'entity match'
            break
          }
        }
        // Tag match — min 4 chars to avoid noise
        if (!reason) {
          for (const tag of (prop.tags || [])) {
            if (tag && tag.length >= 4 && rowText.includes(tag.toLowerCase())) {
              reason = 'tag match'
              break
            }
          }
        }
        // "same section" intentionally removed — too broad, generates noise
        if (reason) {
          candidates.push({ title, path, section, reason, checked: false })
        }
      }
      return candidates
    } catch {
      return []
    }
  }

  const handleLink = async (approvedConnections) => {
    setLinking(true)
    try {
      for (const conn of approvedConnections) {
        if (!conn.checked) continue
        let content = ''
        try { content = await readFile(conn.path) } catch { continue }
        // Append editPath to sources: array in frontmatter
        if (content.includes('sources:')) {
          // Find the sources block and append
          content = content.replace(
            /^(sources:\s*\n)((?:\s+-[^\n]*\n)*)/m,
            (_, header, items) => `${header}${items}  - "${editPath}"\n`
          )
        }
        // Append cross-reference footer
        const footer = `\n\n---\n*Also referenced by: [${proposal.title}](${editPath})*`
        if (!content.includes(`Also referenced by: [${proposal.title}]`)) {
          content = content + footer
        }
        await writeFile(conn.path, content)
      }
    } catch (e) {
      setError(`Linking failed: ${e.message}`)
    }
    setLinking(false)
    // Mark linked connections as done — hide panel
    setShowConnections(false)
  }

  // ── Step 3: Save to vault ──────────────────────────────────────────────────

  const handleSave = async () => {
    if (!proposal || !converted) return
    setSaving(true)
    try {
      const source = inputMode === 'url' ? urlValue : (fileName || 'pasted content')
      const typeMap = {
        summaries: 'summary', entities: 'entity', concepts: 'concept',
        comparisons: 'comparison', 'query-results': 'query-result', scheduling: 'scheduling',
      }
      const pageType = typeMap[proposal.wiki_section] || 'summary'
      const tagsYaml = (proposal.tags || []).map(t => `  - ${t}`).join('\n')
      const rawPath = `raw/${TODAY}-${proposal.slug}.md`

      // Save raw converted text to raw/ (immutable source)
      const rawPage = `---
title: "${proposal.title}"
type: raw-source
source: "${source}"
created: ${TODAY}
---

${converted.markdown.trim()}
`
      await writeFile(rawPath, rawPage)

      // Generate structured summary
      setSummarising(true)
      let summaryBody
      try {
        summaryBody = await summarise(converted.markdown, proposal)
        setSummary(summaryBody)
      } catch (e) {
        // Fall back to raw text if summarisation fails
        summaryBody = converted.markdown.trim()
        console.error('Summarise failed, using raw text:', e.message)
      }
      setSummarising(false)

      // Save structured summary to wiki/
      const page = `---
title: "${proposal.title}"
type: ${pageType}
sources:
  - "${source}"
source_count: 1
raw: "${rawPath}"
created: ${TODAY}
updated: ${TODAY}
tags:
${tagsYaml}
status: draft
---

**TLDR:** ${proposal.description}

${summaryBody}
`
      await writeFile(editPath, page)
      await appendToLog(proposal.title, proposal.wiki_section, source)
      await appendToIndex(proposal.title, editPath, proposal.description, source)

      setSaved(true)
      setSavedPath(editPath)
      setShowSuggestions(true)
      const candidates = await findConnections(proposal, editPath)
      if (candidates.length > 0) {
        setConnections(candidates)
        setShowConnections(true)
      }
    } catch (e) {
      setSummarising(false)
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
        'query-results': '## Query Results', 'scheduling': '## Scheduling',
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

  const isWorking = converting || classifying || summarising

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

        {/* Persona selector */}
        {personas.length > 0 && (
          <div style={{ marginTop: '12px' }}>
            <Label>analysing as</Label>
            <select
              value={activePersona?.id || ''}
              onChange={e => setActivePersona(personas.find(p => p.id === e.target.value))}
              style={{ ...fieldStyle, width: '100%' }}
            >
              {personas.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.context ? ` — ${p.context}` : ''}
                </option>
              ))}
            </select>
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
                placeholder="ai, research, strategy, technology..."
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
            >{saved ? '✓ saved to wiki' : summarising ? '⟳ summarising…' : saving ? 'saving…' : '▼ save to wiki'}</button>

            {saved && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-muted)' }}>
                  ↳ {editPath}<br />
                  ↳ raw/{TODAY}-{proposal?.slug}.md<br />
                  ↳ log.md updated<br />
                  ↳ INDEX.md updated
                </div>
                <button onClick={reset} style={{ ...ghostBtn, padding: '8px' }}>+ ingest another</button>
              </div>
            )}

            {showConnections && connections.length > 0 && (
              <div style={{
                border: '1px solid var(--forge-border)', borderRadius: '4px',
                overflow: 'hidden', marginTop: '4px',
              }}>
                {/* Panel header */}
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '7px 10px', borderBottom: '1px solid var(--forge-border)',
                  background: 'var(--forge-surface)',
                }}>
                  <span style={{
                    fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
                    color: 'var(--forge-muted)', textTransform: 'uppercase', letterSpacing: '0.1em',
                  }}>Proposed Connections</span>
                  <button
                    onClick={() => setShowConnections(false)}
                    style={{
                      background: 'none', border: 'none', color: 'var(--forge-muted)',
                      fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem',
                      cursor: 'pointer', padding: '0 2px', lineHeight: 1,
                    }}
                  >dismiss</button>
                </div>

                {/* Candidate rows */}
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {connections.map((conn, i) => (
                    <label
                      key={conn.path}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '7px 10px', cursor: 'pointer',
                        borderBottom: i < connections.length - 1 ? '1px solid var(--forge-border)' : 'none',
                        background: conn.checked ? 'rgba(255,255,255,0.03)' : 'transparent',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={conn.checked}
                        onChange={e => setConnections(prev =>
                          prev.map((c, j) => j === i ? { ...c, checked: e.target.checked } : c)
                        )}
                        style={{ accentColor: 'var(--forge-accent)', flexShrink: 0 }}
                      />
                      <span
                        title={conn.path}
                        style={{
                          fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem',
                          color: 'var(--forge-text)', flex: 1, overflow: 'hidden',
                          textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                      >{conn.title.length > 32 ? conn.title.slice(0, 32) + '…' : conn.title}</span>
                      <span style={{
                        fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
                        color: 'var(--forge-muted)', background: 'var(--forge-surface)',
                        border: '1px solid var(--forge-border)', borderRadius: '3px',
                        padding: '1px 5px', flexShrink: 0,
                      }}>{conn.section}</span>
                      <span style={{
                        fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
                        color: 'var(--forge-accent)', flexShrink: 0,
                      }}>{conn.reason}</span>
                    </label>
                  ))}
                </div>

                {/* Footer action */}
                <div style={{ padding: '8px 10px', borderTop: '1px solid var(--forge-border)', background: 'var(--forge-surface)' }}>
                  <button
                    onClick={() => handleLink(connections)}
                    disabled={linking || connections.every(c => !c.checked)}
                    style={{
                      background: connections.some(c => c.checked) ? 'var(--forge-accent)' : 'var(--forge-surface)',
                      border: `1px solid ${connections.some(c => c.checked) ? 'var(--forge-accent)' : 'var(--forge-border)'}`,
                      color: connections.some(c => c.checked) ? '#000' : 'var(--forge-muted)',
                      fontFamily: 'JetBrains Mono, monospace', fontSize: '0.68rem',
                      padding: '5px 12px', cursor: (linking || connections.every(c => !c.checked)) ? 'default' : 'pointer',
                      borderRadius: '3px', opacity: linking ? 0.7 : 1,
                    }}
                  >
                    {linking
                      ? '◌ linking…'
                      : `Link selected (${connections.filter(c => c.checked).length})`
                    }
                  </button>
                </div>
              </div>
            )}

            {showSuggestions && proposal && savedPath && (
              <Suggestions
                classification={proposal}
                savedPath={savedPath}
                persona={activePersona}
                onClose={() => setShowSuggestions(false)}
              />
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
