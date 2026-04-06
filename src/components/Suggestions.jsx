import { useState } from 'react'
import { readFile, writeFile } from '../lib/obsidian.js'
import { buildPersonaContext } from '../lib/personas.js'

const TODAY = () => new Date().toISOString().split('T')[0]

/**
 * Context reasoner — shown after a wiki ingest.
 * Takes the classification proposal + active persona and suggests
 * relevant follow-on actions. Each action can be auto-generated.
 */

const SUGGESTIONS_PROMPT = `You are a context-aware assistant helping a knowledge worker decide what to do next after ingesting a document.

You will be given:
1. The active persona/lens (who they are and how they think)
2. The classified document metadata

Suggest 2-4 specific, actionable next steps. Be concrete — name the output, not the activity.

Rules:
- Only suggest things that are genuinely useful given this specific document
- Do not suggest generic things like "read more" or "take notes"
- Each suggestion must be something that can be produced as a document
- Match suggestions to the document type: analytical documents suggest synthesis outputs, meeting/transcript documents suggest action summaries, research documents suggest structured summaries or comparisons

Return ONLY a JSON array with no preamble:
[
  {
    "id": "unique-slug",
    "label": "Short action title (3-6 words)",
    "description": "One sentence: what this produces and why it's useful",
    "template_type": "briefing|meeting-note|analysis|summary|entity-update|comparison|other",
    "output_path": "suggested vault path for the output",
    "auto_generatable": true
  }
]`

const GENERATE_PROMPT = (persona, doc, suggestion, templateContent) => `
${buildPersonaContext(persona)}

---

You are producing: **${suggestion.label}**

Document being analysed:
- Title: ${doc.title}
- Type: ${doc.source_type}
- Description: ${doc.description}
- Tags: ${(doc.tags || []).join(', ')}
- Key entities: ${(doc.key_entities || []).join(', ')}

${templateContent ? `Use this output template as your structure:\n\n${templateContent}\n\n---\n` : ''}

Produce the ${suggestion.label} now. Be specific to this document — do not be generic.
Draw on the persona lens above. Write in a direct, concise style with no padding.
Format as clean markdown suitable for an Obsidian note.
`

export function Suggestions({ classification, savedPath, persona, onClose }) {
  const [suggestions, setSuggestions] = useState(null)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(null) // suggestion id
  const [generated, setGenerated] = useState({}) // id → { content, saved }
  const [error, setError] = useState(null)

  const fetchSuggestions = async () => {
    setLoading(true)
    setError(null)
    try {
      const personaContext = buildPersonaContext(persona)
      const docContext = JSON.stringify({
        title: classification.title,
        source_type: classification.source_type,
        wiki_section: classification.wiki_section,
        description: classification.description,
        tags: classification.tags,
        key_entities: classification.key_entities,
      }, null, 2)

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
          max_tokens: 800,
          messages: [{
            role: 'user',
            content: `${SUGGESTIONS_PROMPT}\n\nPersona:\n${personaContext}\n\nDocument:\n${docContext}`,
          }],
        }),
      })
      const data = await res.json()
      const text = data.content?.[0]?.text || '[]'
      const clean = text.replace(/```json|```/g, '').trim()
      setSuggestions(JSON.parse(clean))
    } catch (e) {
      setError(`Failed to get suggestions: ${e.message}`)
    }
    setLoading(false)
  }

  const handleGenerate = async (suggestion) => {
    setGenerating(suggestion.id)
    try {
      // Try to load a matching template from the vault
      let templateContent = ''
      try {
        templateContent = await readFile(`templates/${suggestion.template_type}.md`)
      } catch {
        // No template — Claude will use its own structure
      }

      const prompt = GENERATE_PROMPT(persona, classification, suggestion, templateContent)

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
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      const data = await res.json()
      const content = data.content?.[0]?.text || ''
      setGenerated(prev => ({ ...prev, [suggestion.id]: { content, saved: false } }))
    } catch (e) {
      setError(`Generation failed: ${e.message}`)
    }
    setGenerating(null)
  }

  const handleSave = async (suggestion) => {
    const gen = generated[suggestion.id]
    if (!gen) return
    try {
      const outputPath = suggestion.output_path ||
        `wiki/query-results/${TODAY()}-${suggestion.id}.md`

      const wrapped = `---
title: "${suggestion.label} — ${classification.title}"
type: query-result
sources:
  - "${savedPath}"
created: ${TODAY()}
updated: ${TODAY()}
tags: []
---

${gen.content}
`
      await writeFile(outputPath, wrapped)
      setGenerated(prev => ({ ...prev, [suggestion.id]: { ...gen, saved: true, path: outputPath } }))
    } catch (e) {
      setError(`Save failed: ${e.message}`)
    }
  }

  // Auto-fetch suggestions when component mounts
  if (suggestions === null && !loading && !error) {
    fetchSuggestions()
  }

  return (
    <div style={{
      borderTop: '1px solid var(--forge-border)',
      marginTop: '16px',
      paddingTop: '16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <Label>suggested next actions</Label>
        {onClose && (
          <button onClick={onClose} style={{ ...ghostBtn, padding: '2px 8px' }}>dismiss</button>
        )}
      </div>

      {loading && (
        <div style={mutedMono}>◌ reasoning about what to do next…</div>
      )}

      {error && (
        <div style={{ color: 'var(--forge-red)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem' }}>{error}</div>
      )}

      {suggestions && suggestions.length === 0 && (
        <div style={mutedMono}>no specific follow-on actions suggested for this document</div>
      )}

      {suggestions && suggestions.map(s => (
        <div key={s.id} style={{
          border: '1px solid var(--forge-border)', borderRadius: '4px',
          padding: '12px', marginBottom: '8px', background: 'var(--forge-surface)',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
            <div style={{ flex: 1 }}>
              <div style={{
                fontFamily: 'Syne, sans-serif', fontWeight: 600, fontSize: '0.82rem',
                color: 'var(--forge-text)', marginBottom: '4px',
              }}>{s.label}</div>
              <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-muted)', lineHeight: 1.6 }}>
                {s.description}
              </div>
            </div>
            {!generated[s.id] && (
              <button
                onClick={() => handleGenerate(s)}
                disabled={generating === s.id || !s.auto_generatable}
                style={{
                  background: s.auto_generatable ? 'var(--forge-accent)' : 'var(--forge-surface)',
                  border: s.auto_generatable ? 'none' : '1px solid var(--forge-border)',
                  color: s.auto_generatable ? '#000' : 'var(--forge-muted)',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem',
                  padding: '5px 10px', borderRadius: '3px',
                  cursor: s.auto_generatable && generating !== s.id ? 'pointer' : 'default',
                  whiteSpace: 'nowrap', flexShrink: 0,
                  opacity: generating === s.id ? 0.6 : 1,
                }}
              >
                {generating === s.id ? '◌ generating…' : s.auto_generatable ? '⚡ generate' : 'manual'}
              </button>
            )}
          </div>

          {generated[s.id] && (
            <div style={{ marginTop: '10px' }}>
              <div style={{
                background: '#0d0d0d', border: '1px solid var(--forge-border)',
                borderRadius: '3px', padding: '10px', maxHeight: '160px', overflow: 'auto',
                fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem',
                color: 'var(--forge-muted)', lineHeight: 1.6, whiteSpace: 'pre-wrap',
              }}>
                {generated[s.id].content.slice(0, 600)}{generated[s.id].content.length > 600 ? '\n…' : ''}
              </div>
              <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                {!generated[s.id].saved ? (
                  <button onClick={() => handleSave(s)} style={{ ...accentBtn, flex: 1 }}>
                    ▼ save to wiki
                  </button>
                ) : (
                  <div style={{ ...mutedMono, padding: '4px 0' }}>
                    ✓ saved → {generated[s.id].path}
                  </div>
                )}
                <button onClick={() => handleGenerate(s)} style={{ ...ghostBtn, padding: '5px 10px' }}>
                  ↺ regenerate
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function Label({ children }) {
  return (
    <div style={{
      fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
      color: 'var(--forge-muted)', textTransform: 'uppercase', letterSpacing: '0.1em',
    }}>{children}</div>
  )
}

const mutedMono = {
  fontFamily: 'JetBrains Mono, monospace', fontSize: '0.68rem',
  color: 'var(--forge-muted)', lineHeight: 1.7,
}

const ghostBtn = {
  background: 'none', border: '1px solid var(--forge-border)',
  color: 'var(--forge-muted)', fontFamily: 'JetBrains Mono, monospace',
  fontSize: '0.7rem', cursor: 'pointer', borderRadius: '3px',
}

const accentBtn = {
  background: 'var(--forge-accent)', border: 'none', color: '#000',
  fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '0.78rem',
  padding: '6px 10px', cursor: 'pointer', borderRadius: '3px', letterSpacing: '0.04em',
}
