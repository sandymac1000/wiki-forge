import { useState, useEffect, useRef } from 'react'
import { readFile, writeFile } from '../lib/obsidian.js'
import { loadPersonas, getDefaultPersona, buildPersonaContext } from '../lib/personas.js'

const TODAY = () => new Date().toISOString().split('T')[0]

// Sonnet 4.5 pricing per million tokens (update if model changes)
const COST_PER_M_IN  = 3.00
const COST_PER_M_OUT = 15.00

function calcCost(inputTokens, outputTokens) {
  return ((inputTokens / 1_000_000) * COST_PER_M_IN) +
         ((outputTokens / 1_000_000) * COST_PER_M_OUT)
}

const QUERY_SYSTEM = (personaContext) => `You are a knowledge base analyst.
${personaContext ? `\nOperating through this lens:\n${personaContext}\n` : ''}
You have access to a personal wiki of accumulated knowledge. You will be given:
1. The wiki index (titles, TLDRs, paths)
2. The full content of relevant pages

Your job is to synthesise a precise, direct answer. Rules:
- Cite specific wiki pages by title when drawing on them
- Be direct — lead with the answer, not the methodology
- Flag explicitly when the wiki doesn't have enough information to answer well
- If the question would benefit from a page the wiki is missing, say so
- Match the persona lens in tone and analytical frame`

const FIND_PAGES_PROMPT = (question, index) =>
`Given this question: "${question}"

And this wiki index:
${index}

Return ONLY a JSON array of the most relevant page paths (up to 8), ordered by relevance:
["wiki/summaries/...", "wiki/entities/..."]

If no pages are clearly relevant, return [].`

const SYNTHESISE_PROMPT = (question, pagesContent) =>
`Question: ${question}

Wiki content:
${pagesContent}

Answer the question directly and precisely. Cite pages by title. Be concise unless depth is genuinely needed.`

export function WikiQuery() {
  const [question, setQuestion] = useState('')
  const [personas, setPersonas] = useState([])
  const [activePersona, setActivePersona] = useState(null)
  const [status, setStatus] = useState(null)
  const [answer, setAnswer] = useState(null)       // final answer
  const [streaming, setStreaming] = useState('')    // answer as it arrives
  const [sources, setSources] = useState([])
  const [usage, setUsage] = useState(null)          // { inputTokens, outputTokens, cost }
  const [error, setError] = useState(null)
  const [running, setRunning] = useState(false)
  const [saved, setSaved] = useState(false)
  const [history, setHistory] = useState([])
  const answerRef = useRef(null)

  useEffect(() => {
    loadPersonas().then(loaded => {
      setPersonas(loaded)
      setActivePersona(getDefaultPersona(loaded))
    })
  }, [])

  // Auto-scroll answer panel as streaming arrives
  useEffect(() => {
    if (answerRef.current) answerRef.current.scrollTop = answerRef.current.scrollHeight
  }, [streaming])

  // Non-streaming call (for find-pages step — small, fast)
  const callClaude = async (messages, maxTokens = 400) => {
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
        max_tokens: maxTokens,
        system: QUERY_SYSTEM(buildPersonaContext(activePersona)),
        messages,
      }),
    })
    const data = await res.json()
    if (data.error) throw new Error(data.error.message)
    return { text: data.content?.[0]?.text || '', usage: data.usage }
  }

  // Streaming call (for synthesis — longer, benefits from streaming)
  const callClaudeStream = async (messages, maxTokens = 2000, onChunk) => {
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
        max_tokens: maxTokens,
        stream: true,
        system: QUERY_SYSTEM(buildPersonaContext(activePersona)),
        messages,
      }),
    })
    if (!res.ok) throw new Error(`API error: ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let full = ''
    let inputTokens = 0, outputTokens = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') continue
        try {
          const json = JSON.parse(data)
          if (json.type === 'content_block_delta' && json.delta?.text) {
            full += json.delta.text
            onChunk(full)
          }
          if (json.type === 'message_delta' && json.usage) {
            outputTokens = json.usage.output_tokens
          }
          if (json.type === 'message_start' && json.message?.usage) {
            inputTokens = json.message.usage.input_tokens
          }
        } catch {}
      }
    }
    return { text: full, usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
  }

  const handleQuery = async () => {
    if (!question.trim() || running) return
    setRunning(true)
    setAnswer(null)
    setStreaming('')
    setSources([])
    setUsage(null)
    setError(null)
    setSaved(false)

    let totalInput = 0, totalOutput = 0

    try {
      // Step 1: Read index
      setStatus('reading wiki index…')
      let index = ''
      try {
        index = await readFile('wiki/INDEX.md')
      } catch {
        throw new Error('Could not read wiki/INDEX.md — make sure Obsidian is open with your vault.')
      }

      // Step 2: Find relevant pages
      setStatus('finding relevant pages…')
      const findResult = await callClaude([{
        role: 'user',
        content: FIND_PAGES_PROMPT(question, index),
      }], 400)
      totalInput  += findResult.usage?.input_tokens  || 0
      totalOutput += findResult.usage?.output_tokens || 0

      let pagePaths = []
      try {
        const clean = findResult.text.replace(/```json|```/g, '').trim()
        pagePaths = JSON.parse(clean)
      } catch { pagePaths = [] }

      // Step 3: Read pages
      const pageContents = []
      for (const path of pagePaths.slice(0, 8)) {
        setStatus(`reading ${path.split('/').pop()}…`)
        try {
          const content = await readFile(path)
          pageContents.push({ path, title: path.split('/').pop().replace('.md', ''), content: content.slice(0, 3000) })
        } catch {}
      }
      setSources(pageContents.map(p => p.title))

      // Step 4: Stream synthesis
      setStatus('synthesising…')
      const pagesText = pageContents.length > 0
        ? pageContents.map(p => `## ${p.title}\n${p.content}`).join('\n\n---\n\n')
        : '(No relevant pages found in wiki)'

      const synthResult = await callClaudeStream([{
        role: 'user',
        content: SYNTHESISE_PROMPT(question, pagesText),
      }], 2000, (partial) => {
        setStreaming(partial)
        setStatus(null)
      })

      totalInput  += synthResult.usage?.input_tokens  || 0
      totalOutput += synthResult.usage?.output_tokens || 0

      const cost = calcCost(totalInput, totalOutput)
      setUsage({ inputTokens: totalInput, outputTokens: totalOutput, cost })
      setAnswer(synthResult.text)
      setStreaming('')
      setHistory(prev => [{ question, answer: synthResult.text, sources: pageContents.map(p => p.title), persona: activePersona?.name }, ...prev.slice(0, 9)])

    } catch (e) {
      setError(e.message)
      setStatus(null)
    }
    setRunning(false)
  }

  const handleSave = async () => {
    if (!answer) return
    const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)
    const path = `wiki/query-results/${TODAY()}-${slug}.md`
    const sourcesYaml = sources.map(s => `  - "${s}"`).join('\n')
    const costLine = usage ? `\n**Cost:** $${usage.cost.toFixed(5)} (${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out)` : ''
    const page = `---
title: "${question}"
type: query-result
sources:
${sourcesYaml || '  []'}
created: ${TODAY()}
updated: ${TODAY()}
tags: []
---

**Question:** ${question}
**Persona:** ${activePersona?.name || 'default'}${costLine}

---

${answer}
`
    try {
      await writeFile(path, page)
      try {
        const log = await readFile('wiki/log.md')
        await writeFile('wiki/log.md', log + `\n## [${TODAY()}] query | ${question.slice(0, 60)}\n\nSaved to: ${path}\n`)
      } catch {}
      setSaved(true)
    } catch (e) {
      setError(`Save failed: ${e.message}`)
    }
  }

  const displayAnswer = answer || streaming

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 52px)', overflow: 'hidden' }}>

      {/* Left — input + history */}
      <div style={{ width: '340px', minWidth: '340px', borderRight: '1px solid var(--forge-border)', display: 'flex', flexDirection: 'column', padding: '20px' }}>

        {personas.length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            <Label>lens</Label>
            <select
              value={activePersona?.id || ''}
              onChange={e => setActivePersona(personas.find(p => p.id === e.target.value))}
              style={{ ...fieldStyle, width: '100%' }}
            >
              {personas.map(p => (
                <option key={p.id} value={p.id}>{p.name}{p.context ? ` — ${p.context}` : ''}</option>
              ))}
            </select>
          </div>
        )}

        <Label>question</Label>
        <textarea
          value={question}
          onChange={e => { setQuestion(e.target.value); setAnswer(null); setStreaming(''); setSaved(false) }}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleQuery() }}
          placeholder={`Ask anything across your wiki…\n\nExamples:\n• What are the common themes across my research on [topic]?\n• Summarise everything I know about [subject]\n• Compare what I've written about X versus Y\n• What are the open questions in my notes on [area]?\n• What should I prepare before my meeting on [topic]?\n\n⌘↵ to run`}
          style={{
            flex: 1, background: 'var(--forge-surface)', border: '1px solid var(--forge-border)',
            color: 'var(--forge-text)', fontFamily: 'JetBrains Mono, monospace',
            fontSize: '0.75rem', lineHeight: 1.7, padding: '12px',
            borderRadius: '4px', outline: 'none', resize: 'none',
          }}
        />

        <button
          onClick={handleQuery}
          disabled={!question.trim() || running}
          style={{
            marginTop: '10px',
            background: running ? 'var(--forge-surface)' : (question.trim() ? 'var(--forge-accent)' : 'var(--forge-surface)'),
            border: 'none',
            color: running ? 'var(--forge-muted)' : (question.trim() ? '#000' : 'var(--forge-muted)'),
            fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.9rem',
            padding: '11px', borderRadius: '4px', letterSpacing: '0.05em',
            cursor: !question.trim() || running ? 'default' : 'pointer',
          }}
        >{running ? `◌ ${status || 'synthesising…'}` : '⌖ run query'}</button>

        {history.length > 0 && (
          <div style={{ marginTop: '20px', overflow: 'auto' }}>
            <Label>this session</Label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
              {history.map((h, i) => (
                <button key={i} onClick={() => { setQuestion(h.question); setAnswer(h.answer); setStreaming(''); setSources(h.sources); setSaved(false) }}
                  style={{
                    background: 'none', border: '1px solid var(--forge-border)', borderRadius: '3px',
                    color: 'var(--forge-muted)', fontFamily: 'JetBrains Mono, monospace',
                    fontSize: '0.62rem', padding: '5px 8px', cursor: 'pointer',
                    textAlign: 'left', lineHeight: 1.4,
                  }}
                >
                  {h.question.slice(0, 55)}{h.question.length > 55 ? '…' : ''}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right — answer */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '20px', overflow: 'hidden' }}>

        {!displayAnswer && !error && !running && (
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem', color: 'var(--forge-muted)', lineHeight: 2 }}>
            ask a question — claude will search your wiki and synthesise an answer<br /><br />
            the more you've ingested, the better this gets
          </div>
        )}

        {error && (
          <div style={{ color: 'var(--forge-red)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.72rem', padding: '12px', background: 'var(--forge-surface)', borderRadius: '4px' }}>
            {error}
          </div>
        )}

        {(displayAnswer || sources.length > 0) && (
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>

            {/* Sources */}
            {sources.length > 0 && (
              <div style={{ marginBottom: '12px', flexShrink: 0 }}>
                <Label>sources read</Label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                  {sources.map(s => (
                    <span key={s} style={{
                      fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem',
                      color: 'var(--forge-accent)', background: 'var(--forge-surface)',
                      border: '1px solid var(--forge-border)', padding: '2px 8px', borderRadius: '3px',
                    }}>{s}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Answer — scrollable */}
            {displayAnswer && (
              <>
                <Label>answer {streaming && !answer ? <span style={{ color: 'var(--forge-accent)' }}>● streaming</span> : ''}</Label>
                <div ref={answerRef} style={{
                  flex: 1, marginTop: '8px', fontFamily: 'DM Sans, sans-serif',
                  fontSize: '0.85rem', lineHeight: 1.8, color: 'var(--forge-text)',
                  whiteSpace: 'pre-wrap', overflow: 'auto', paddingRight: '4px',
                }}>
                  {displayAnswer}
                  {streaming && !answer && <span style={{ opacity: 0.4 }}>█</span>}
                </div>
              </>
            )}

            {/* Usage + save bar */}
            {answer && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '12px',
                marginTop: '12px', paddingTop: '12px',
                borderTop: '1px solid var(--forge-border)', flexShrink: 0,
              }}>
                {/* Token / cost summary */}
                {usage && (
                  <div style={{
                    fontFamily: 'JetBrains Mono, monospace', fontSize: '0.62rem',
                    color: 'var(--forge-muted)', display: 'flex', gap: '12px', flex: 1,
                  }}>
                    <span>↑ {usage.inputTokens.toLocaleString()} in</span>
                    <span>↓ {usage.outputTokens.toLocaleString()} out</span>
                    <span style={{ color: 'var(--forge-accent)' }}>${usage.cost.toFixed(5)}</span>
                  </div>
                )}

                <div style={{ display: 'flex', gap: '6px' }}>
                  {!saved ? (
                    <button onClick={handleSave} style={{
                      background: 'var(--forge-accent)', border: 'none', color: '#000',
                      fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.78rem',
                      padding: '7px 14px', borderRadius: '4px', cursor: 'pointer', letterSpacing: '0.04em',
                    }}>▼ save</button>
                  ) : (
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-muted)', padding: '7px 0' }}>
                      ✓ saved
                    </span>
                  )}
                  <button onClick={() => { setAnswer(null); setStreaming(''); setSources([]); setSaved(false); setQuestion(''); setUsage(null) }}
                    style={ghostBtn}>clear</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
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

const fieldStyle = {
  background: 'var(--forge-surface)', border: '1px solid var(--forge-border)',
  color: 'var(--forge-text)', fontFamily: 'JetBrains Mono, monospace',
  fontSize: '0.7rem', padding: '6px 8px', borderRadius: '4px', outline: 'none',
}

const ghostBtn = {
  background: 'none', border: '1px solid var(--forge-border)',
  color: 'var(--forge-muted)', fontFamily: 'JetBrains Mono, monospace',
  fontSize: '0.7rem', padding: '6px 12px', cursor: 'pointer', borderRadius: '3px',
}
