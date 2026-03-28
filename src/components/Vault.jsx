import { useState, useEffect, useCallback } from 'react'
import { listVault, readFile, writeFile, deleteFile, stripFrontmatter, parseFrontmatter } from '../lib/obsidian.js'

function FileTree({ items, onSelect, selected, path = '' }) {
  const folders = (items?.files || []).filter(f => f.endsWith('/')).map(f => f.slice(0, -1))
  const files = (items?.files || []).filter(f => !f.endsWith('/'))

  return (
    <div>
      {files.map(f => (
        <div
          key={f}
          onClick={() => onSelect(path ? `${path}/${f}` : f)}
          style={{
            padding: '4px 12px 4px 16px',
            cursor: 'pointer',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: '0.72rem',
            color: selected === (path ? `${path}/${f}` : f) ? 'var(--forge-accent)' : 'var(--forge-text)',
            background: selected === (path ? `${path}/${f}` : f) ? 'var(--forge-surface)' : 'transparent',
            borderLeft: selected === (path ? `${path}/${f}` : f) ? '2px solid var(--forge-accent)' : '2px solid transparent',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            transition: 'all 0.1s',
          }}
        >
          {f}
        </div>
      ))}
      {folders.map(folder => (
        <FolderNode
          key={folder}
          name={folder}
          path={path ? `${path}/${folder}` : folder}
          onSelect={onSelect}
          selected={selected}
        />
      ))}
    </div>
  )
}

function FolderNode({ name, path, onSelect, selected }) {
  const [open, setOpen] = useState(true)
  const [items, setItems] = useState(null)

  useEffect(() => {
    if (open && !items) {
      listVault(path + '/').then(setItems).catch(() => setItems({ files: [], folders: [] }))
    }
  }, [open, path, items])

  return (
    <div>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          padding: '4px 12px',
          cursor: 'pointer',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '0.72rem',
          color: 'var(--forge-muted)',
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: '0.6rem' }}>{open ? '▼' : '▶'}</span>
        <span style={{ color: 'var(--forge-accent-dim)', fontWeight: 500 }}>{name}/</span>
      </div>
      {open && items && (
        <div style={{ paddingLeft: '12px' }}>
          <FileTree items={items} onSelect={onSelect} selected={selected} path={path} />
        </div>
      )}
    </div>
  )
}

export function Vault() {
  const [root, setRoot] = useState(null)
  const [selected, setSelected] = useState(null)
  const [content, setContent] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [newFilePath, setNewFilePath] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showClone, setShowClone] = useState(false)
  const [cloneName, setCloneName] = useState('')
  const [cloning, setCloning] = useState(false)
  const [rating, setRating] = useState(null)
  const [treeKey, setTreeKey] = useState(0)

  useEffect(() => {
    listVault('').then(setRoot).catch(e => setError(e.message))
  }, [])

  const handleSelect = useCallback(async (path) => {
    setSelected(path)
    setEditing(false)
    setError(null)
    try {
      const text = await readFile(path)
      setContent(text)
      setDraft(text)
      const fm = parseFrontmatter(text)
      setRating(fm.rating && fm.rating !== 'null' ? parseInt(fm.rating) : null)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await writeFile(selected, draft)
      setContent(draft)
      setEditing(false)
    } catch (e) {
      setError(e.message)
    }
    setSaving(false)
  }

  const handleDelete = async () => {
    if (!confirm(`Delete ${selected}?`)) return
    try {
      await deleteFile(selected)
      setSelected(null)
      setContent('')
      listVault('').then(setRoot)
    } catch (e) {
      setError(e.message)
    }
  }

  const handleNew = async () => {
    if (!newFilePath) return
    const path = newFilePath.endsWith('.md') ? newFilePath : newFilePath + '.md'
    try {
      await writeFile(path, `---\ntitle: ${path}\n---\n\n`)
      setShowNew(false)
      setNewFilePath('')
      listVault('').then(setRoot)
      handleSelect(path)
    } catch (e) {
      setError(e.message)
    }
  }
  const handleClone = async () => {
  if (!cloneName.trim() || !selected) return
  setCloning(true)
  try {
    const body = stripFrontmatter(content).trim()
    // Classify the specialised prompt
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
        messages: [{ role: 'user', content: `You are a prompt librarian. Analyse the prompt text provided and return ONLY a JSON object with no preamble, no markdown, no backticks.\n\nReturn exactly this structure:\n{\n  "title": "${cloneName.trim()}",\n  "slug": "kebab-case-slug-for-the-title",\n  "category": "vc|learning|tools|reasoning|writing|research|other",\n  "subcategory": "more specific type",\n  "params": "comma separated context variables",\n  "description": "One sentence describing what this prompt does"\n}\n\nPrompt to classify:\n\n${body}` }]
      })
    })
    const data = await res.json()
    const text = data.content?.[0]?.text || ''
    const fm = JSON.parse(text.replace(/```json|```/g, '').trim())
    const savePath = `prompts/_templates/${fm.category}/${fm.slug}.md`
    const newContent = `---
title: ${fm.title}
category: ${fm.category}
subcategory: ${fm.subcategory}
params: ${fm.params}
description: ${fm.description}
version: 1
rating: ${parseFrontmatter(content).rating || 'null'}
last_used: null
notes: ""
---

${body}
`
    await writeFile(savePath, newContent)
    setShowClone(false)
    setCloneName('')
    listVault('').then(setRoot)
    setTreeKey(k => k + 1)
    handleSelect(savePath)
  } catch (e) {
    setError(`Clone failed: ${e.message}`)
  }
  setCloning(false)
}
const handleRate = async (r) => {
  if (!selected) return
  setRating(r)
  const fm = parseFrontmatter(content)
  const updated = content.replace(
    /^rating:.*$/m,
    `rating: ${r}`
  )
  if (updated === content) return // no rating field found
  await writeFile(selected, updated)
  setContent(updated)
  setDraft(updated)
}
  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 52px)', overflow: 'hidden' }}>
      <aside style={{
        width: '240px',
        minWidth: '240px',
        borderRight: '1px solid var(--forge-border)',
        overflow: 'auto',
        paddingTop: '8px',
      }}>
        <div style={{
          padding: '8px 12px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Remi vault</span>
          <button
            onClick={() => setShowNew(s => !s)}
            style={{
              background: 'none', border: '1px solid var(--forge-border)', color: 'var(--forge-muted)',
              fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem', padding: '2px 6px',
              cursor: 'pointer', borderRadius: '3px',
            }}
          >+ new</button>
        </div>

        {showNew && (
          <div style={{ padding: '4px 12px 8px', display: 'flex', gap: '4px' }}>
            <input
              value={newFilePath}
              onChange={e => setNewFilePath(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleNew()}
              placeholder="prompts/path/file"
              style={{
                flex: 1, background: 'var(--forge-surface)', border: '1px solid var(--forge-border)',
                color: 'var(--forge-text)', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem',
                padding: '3px 6px', borderRadius: '3px', outline: 'none',
              }}
            />
            <button onClick={handleNew} style={{ background: 'var(--forge-accent)', border: 'none', color: '#000', fontSize: '0.65rem', padding: '3px 8px', cursor: 'pointer', borderRadius: '3px', fontWeight: 600 }}>↵</button>
          </div>
        )}

        {root ? <FileTree key={treeKey} items={root} onSelect={handleSelect} selected={selected} /> : (
          <div style={{ padding: '12px', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-muted)' }}>loading…</div>
        )}
      </aside>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selected ? (
          <>
            <div style={{
              borderBottom: '1px solid var(--forge-border)',
              padding: '8px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              background: 'var(--forge-surface)',
            }}>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem', color: 'var(--forge-muted)', flex: 1 }}>{selected}</span>
              {editing ? (
                <>
                  <Btn onClick={handleSave} accent disabled={saving}>{saving ? 'saving…' : 'save'}</Btn>
                  <Btn onClick={() => { setEditing(false); setDraft(content) }}>cancel</Btn>
                </>
              ) : (
                <>
                  <Btn onClick={() => setEditing(true)}>edit</Btn>
                  <Btn onClick={handleDelete} danger>delete</Btn>
                  <Btn onClick={() => setShowClone(s => !s)}>clone</Btn>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginLeft: '8px' }}>
  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem', color: 'var(--forge-muted)' }}>rate</span>
                    {[1,2,3,4,5].map(r => (
                      <div
                        key={r}
                        onClick={() => handleRate(r)}
                        title={`Rate ${r}/5`}
                        style={{
                          width: '10px', height: '10px', borderRadius: '50%',
                          background: rating >= r ? 'var(--forge-accent)' : 'var(--forge-border)',
                          boxShadow: rating >= r ? '0 0 4px var(--forge-accent)' : 'none',
                          cursor: 'pointer', transition: 'all 0.15s',
                    }}
                   />
                ))}
                {rating && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem', color: 'var(--forge-muted)', marginLeft: '4px' }}>{rating}/5</span>}
                </div>
                </>
              )}
            </div>

            {error && <div style={{ padding: '8px 16px', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem', color: 'var(--forge-red)' }}>{error}</div>}

            {showClone && !editing && (
              <div style={{
                padding: '8px 16px', borderBottom: '1px solid var(--forge-border)',
                background: 'color-mix(in srgb, var(--forge-accent) 5%, var(--forge-surface))',
                display: 'flex', gap: '8px', alignItems: 'center',
              }}>
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-accent)', whiteSpace: 'nowrap' }}>clone as →</span>
                <input
                  value={cloneName}
                  onChange={e => setCloneName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleClone()}
                  placeholder="e.g. Paper Digest — Bioinformatics"
                  autoFocus
                  style={{
                    flex: 1, background: 'var(--forge-bg)', border: '1px solid var(--forge-accent)',
                    color: 'var(--forge-text)', fontFamily: 'DM Sans, sans-serif', fontSize: '0.78rem',
                    padding: '5px 10px', borderRadius: '4px', outline: 'none',
                }}
              />
              <Btn onClick={handleClone} accent disabled={!cloneName.trim() || cloning}>
                {cloning ? '◌ cloning…' : '↵ clone'}
            </Btn>
            <Btn onClick={() => { setShowClone(false); setCloneName('') }}>cancel</Btn>
          </div>
        )}  

            {editing ? (
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                style={{
                  flex: 1, background: 'var(--forge-bg)', border: 'none', outline: 'none',
                  color: 'var(--forge-text)', fontFamily: 'JetBrains Mono, monospace',
                  fontSize: '0.78rem', lineHeight: 1.7, padding: '20px 24px', resize: 'none',
                }}
              />
            ) : (
              <pre style={{
                flex: 1, overflow: 'auto', margin: 0,
                fontFamily: 'JetBrains Mono, monospace', fontSize: '0.78rem',
                lineHeight: 1.7, padding: '20px 24px', color: 'var(--forge-text)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>{content}</pre>
            )}
          </>
        ) : (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem', color: 'var(--forge-muted)',
          }}>
            select a file
          </div>
        )}
      </div>
    </div>
  )
}

function Btn({ children, onClick, accent, danger, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: accent ? 'var(--forge-accent)' : 'var(--forge-surface)',
        border: `1px solid ${danger ? 'var(--forge-red)' : accent ? 'transparent' : 'var(--forge-border)'}`,
        color: accent ? '#000' : danger ? 'var(--forge-red)' : 'var(--forge-muted)',
        fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem',
        padding: '3px 10px', cursor: disabled ? 'default' : 'pointer', borderRadius: '3px',
        opacity: disabled ? 0.5 : 1,
      }}
    >{children}</button>
  )
}