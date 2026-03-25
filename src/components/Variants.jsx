export function Variants() {
  return (
    <Placeholder
      glyph="⌥"
      title="Variants"
      description="Manage persona variants per template. Create, compare and evolve prompt variants with individual rating histories."
      status="session 2"
    />
  )
}

function Placeholder({ glyph, title, description, status }) {
  return (
    <div style={{
      height: 'calc(100vh - 52px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: '12px',
    }}>
      <div style={{
        fontFamily: 'JetBrains Mono, monospace', fontSize: '2.5rem',
        color: 'var(--forge-border-bright)',
      }}>{glyph}</div>
      <div style={{
        fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: '1.1rem',
        color: 'var(--forge-muted)', letterSpacing: '-0.01em',
      }}>{title}</div>
      <div style={{
        fontFamily: 'DM Sans, sans-serif', fontSize: '0.82rem',
        color: 'var(--forge-muted)', maxWidth: '360px', textAlign: 'center',
        lineHeight: 1.6,
      }}>{description}</div>
      <div style={{
        fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem',
        color: 'var(--forge-accent-dim)', background: 'var(--forge-surface)',
        border: '1px solid var(--forge-border)', padding: '3px 10px', borderRadius: '3px',
        marginTop: '4px',
      }}>coming {status}</div>
    </div>
  )
}