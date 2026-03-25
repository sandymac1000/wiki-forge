import { useState, useEffect, useCallback } from 'react'
import { listVault, readFile, writeFile, deleteFile } from '../lib/obsidian.js'

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

        {root ? <FileTree items={root} onSelect={handleSelect} selected={selected} /> : (
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
                </>
              )}
            </div>

            {error && <div style={{ padding: '8px 16px', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem', color: 'var(--forge-red)' }}>{error}</div>}

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