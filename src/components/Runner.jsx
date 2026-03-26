import { useState, useEffect, useRef } from 'react'
import { listVault, readFile, updateFrontmatter, parseFrontmatter, stripFrontmatter } from '../lib/obsidian.js'
import { runPrompt } from '../lib/anthropic.js'

const TEMP_PRESETS = [
  { label: 'precise', value: 0.2, desc: 'factual, low variance' },
  { label: 'balanced', value: 0.5, desc: 'default' },
  { label: 'creative', value: 0.8, desc: 'generative, exploratory' },
  { label: 'wild', value: 1.0, desc: 'max variance' },
]

function buildContext(contextFields) {
  return Object.entries(contextFields)
    .filter(([, v]) => v.trim())
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

function CopyPromptButton({ promptContent, contextFields }) {
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
        userContext ? `\n## Context\n${userContext}` : '',
      ].join('\n')

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
      {copied ? '✓ copied to clipboard' : '⎘ copy full prompt'}
    </button>
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

export function Runner() {
  const [templates, setTemplates] = useState([])
  const [selected, setSelected] = useState(null)
  const [promptContent, setPromptContent] = useState('')
  const [frontmatter, setFrontmatter] = useState({})
  const [temperature, setTemperature] = useState(0.5)
  const [contextFields, setContextFields] = useState({})
  const [output, setOutput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [rating, setRating] = useState(null)
  const [note, setNote] = useState('')
  const [saved, setSaved] = useState(false)
  const outputRef = useRef(null)

  useEffect(() => {
    async function loadTemplates() {
      const walk = async (path) => {
        const items = await listVault(path)
        const allFiles = items.files || []
        const files = allFiles
          .filter(f => !f.endsWith('/') && f.endsWith('.md'))
          .map(f => path + f)
        const folders = allFiles
          .filter(f => f.endsWith('/'))
          .map(f => f.slice(0, -1))
        const nested = await Promise.all(folders.map(folder => walk(path + folder + '/')))
        return [...files, ...nested.flat()]
      }
      const all = await walk('prompts/')
      setTemplates(all)
    }
    loadTemplates().catch(console.error)
  }, [])

  const handleSelect = async (path) => {
    setSelected(path)
    setOutput('')
    setRating(null)
    setNote('')
    setSaved(false)
    setContextFields({})
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

      const userContext = buildContext(contextFields)

      await runPrompt({
        system: systemPrompt,
        user: userContext || 'Begin.',
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

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 52px)', overflow: 'hidden' }}>
      {/* Left panel */}
      <div style={{ width: '300px', minWidth: '300px', borderRight: '1px solid var(--forge-border)', overflow: 'auto', padding: '16px' }}>
        <Label>prompt</Label>
        <select
          value={selected || ''}
          onChange={e => handleSelect(e.target.value)}
          style={selectStyle}
        >
          <option value="">— select —</option>
          {templates.map(t => (
            <option key={t} value={t}>{t.replace('prompts/', '')}</option>
          ))}
        </select>

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
                  <div key={k}>
                    <span style={{ color: 'var(--forge-accent-dim)' }}>{k}:</span> {String(v)}
                  </div>
                ))}
              </div>
            </div>

            <div style={{ marginTop: '12px' }}>
              <Label>temperature — {temperature}</Label>
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '6px' }}>
                {TEMP_PRESETS.map(p => (
                  <button
                    key={p.value}
                    onClick={() => setTemperature(p.value)}
                    title={p.desc}
                    style={{
                      background: temperature === p.value ? 'var(--forge-accent)' : 'var(--forge-surface)',
                      border: '1px solid var(--forge-border)',
                      color: temperature === p.value ? '#000' : 'var(--forge-muted)',
                      fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem',
                      padding: '3px 8px', cursor: 'pointer', borderRadius: '3px',
                    }}
                  >{p.label}</button>
                ))}
              </div>
              <input
                type="range" min="0" max="1" step="0.05"
                value={temperature}
                onChange={e => setTemperature(parseFloat(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--forge-accent)' }}
              />
            </div>

            <div style={{ marginTop: '12px' }}>
              <Label>context</Label>
              <ContextForm
                params={params}
                contextFields={contextFields}
                setContextFields={setContextFields}
              />
            </div>

            <CopyPromptButton
              promptContent={promptContent}
              contextFields={contextFields}
            />

            <button
              onClick={handleRun}
              disabled={streaming}
              style={{
                marginTop: '8px', width: '100%',
                background: streaming ? 'var(--forge-surface)' : 'var(--forge-accent)',
                border: 'none', color: streaming ? 'var(--forge-muted)' : '#000',
                fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.85rem',
                padding: '10px', cursor: streaming ? 'default' : 'pointer', borderRadius: '4px',
                letterSpacing: '0.05em',
              }}
            >{streaming ? '● streaming…' : '▶ run'}</button>
          </>
        )}

        {output && !streaming && (
          <div style={{ marginTop: '20px', borderTop: '1px solid var(--forge-border)', paddingTop: '16px' }}>
            <Label>rate this output</Label>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
              {[1, 2, 3, 4, 5].map(r => (
                <button
                  key={r}
                  onClick={() => setRating(r)}
                  style={{
                    width: '32px', height: '32px',
                    background: rating === r ? 'var(--forge-accent)' : 'var(--forge-surface)',
                    border: '1px solid var(--forge-border)',
                    color: rating === r ? '#000' : 'var(--forge-muted)',
                    fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.85rem',
                    cursor: 'pointer', borderRadius: '4px',
                  }}
                >{r}</button>
              ))}
            </div>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="what worked / what didn't…"
              style={{ ...fieldStyle, height: '60px', marginBottom: '8px', resize: 'vertical' }}
            />
            <button
              onClick={handleSaveRating}
              disabled={rating === null || saved}
              style={{
                width: '100%',
                background: saved ? 'var(--forge-green)' : 'var(--forge-surface)',
                border: `1px solid ${saved ? 'var(--forge-green)' : 'var(--forge-border)'}`,
                color: saved ? '#000' : 'var(--forge-muted)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem',
                padding: '6px', cursor: rating === null || saved ? 'default' : 'pointer',
                borderRadius: '4px',
              }}
            >{saved ? '✓ saved to vault' : 'save rating'}</button>
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