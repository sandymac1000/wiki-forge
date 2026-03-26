import { useState } from 'react'
import { Inbox } from './components/Inbox.jsx'
import { Vault } from './components/Vault.jsx'
import { Runner } from './components/Runner.jsx'
import { Variants } from './components/Variants.jsx'
import { Improvements } from './components/Improvements.jsx'
import { Registry } from './components/Registry.jsx'

const TABS = [
  { id: 'inbox',        label: 'Inbox',        glyph: '⊕' },
  { id: 'vault',        label: 'Vault',        glyph: '◈' },
  { id: 'runner',       label: 'Runner',       glyph: '▶' },
  { id: 'variants',     label: 'Variants',     glyph: '⌥' },
  { id: 'improvements', label: 'Improvements', glyph: '↑' },
  { id: 'registry',     label: 'Registry',     glyph: '≡' },
]

export default function App() {
  const [tab, setTab] = useState('vault')

  return (
    <div style={{ background: 'var(--forge-bg)', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{
        borderBottom: '1px solid var(--forge-border)',
        padding: '0 2rem',
        display: 'flex',
        alignItems: 'center',
        gap: '2rem',
        height: '52px',
        position: 'sticky',
        top: 0,
        background: 'var(--forge-bg)',
        zIndex: 50,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <span style={{
            fontFamily: 'Syne, sans-serif',
            fontWeight: 800,
            fontSize: '1.1rem',
            color: 'var(--forge-accent)',
            letterSpacing: '-0.02em',
          }}>PROMPT FORGE</span>
          <span style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: '0.65rem',
            color: 'var(--forge-muted)',
            background: 'var(--forge-surface)',
            border: '1px solid var(--forge-border)',
            padding: '1px 6px',
            borderRadius: '3px',
          }}>v0.1.0</span>
        </div>
        <nav style={{ display: 'flex', gap: '0', marginLeft: '1rem' }}>
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: tab === t.id ? '2px solid var(--forge-accent)' : '2px solid transparent',
                color: tab === t.id ? 'var(--forge-accent)' : 'var(--forge-muted)',
                fontFamily: 'DM Sans, sans-serif',
                fontSize: '0.82rem',
                fontWeight: tab === t.id ? 500 : 400,
                padding: '0 1rem',
                height: '52px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                transition: 'color 0.15s',
                letterSpacing: '0.02em',
              }}
            >
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.75rem' }}>{t.glyph}</span>
              {t.label}
            </button>
          ))}
        </nav>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{
            width: '6px', height: '6px', borderRadius: '50%',
            background: 'var(--forge-green)',
            boxShadow: '0 0 6px var(--forge-green)',
          }} />
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: 'var(--forge-muted)' }}>
            obsidian connected
          </span>
        </div>
      </header>
      <main style={{ flex: 1, overflow: 'hidden' }}>
        {tab === 'inbox'        && <Inbox />}
        {tab === 'vault'        && <Vault />}
        {tab === 'runner'       && <Runner />}
        {tab === 'variants'     && <Variants />}
        {tab === 'improvements' && <Improvements />}
        {tab === 'registry'     && <Registry />}
      </main>
    </div>
  )
}