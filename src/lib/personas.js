import { listVault, readFile } from './obsidian.js'

/**
 * Load all personas from the vault's personas/ directory.
 * Each persona is a markdown file with YAML frontmatter.
 *
 * Frontmatter fields:
 *   name:     Display name shown in selector
 *   id:       Unique identifier (slug)
 *   default:  true|false — which persona is active by default
 *   context:  Optional — short label shown alongside name (role, project, etc.)
 *   public:   true|false — safe to include in community examples (no personal data)
 */
export async function loadPersonas() {
  try {
    const listing = await listVault('personas/')
    const files = (listing.files || []).filter(f => f.endsWith('.md'))

    const personas = await Promise.all(
      files.map(async (path) => {
        try {
          const content = await readFile(path)
          const meta = parseFrontmatter(content)
          const body = stripFrontmatter(content).trim()
          return {
            id: meta.id || slugify(meta.name || path),
            name: meta.name || path.replace('personas/', '').replace('.md', ''),
            context: meta.context || null,
            isDefault: meta.default === 'true' || meta.default === true,
            isPublic: meta.public === 'true' || meta.public === true,
            body,
            path,
          }
        } catch {
          return null
        }
      })
    )

    const valid = personas.filter(Boolean)
    if (valid.length > 0 && !valid.some(p => p.isDefault)) {
      valid[0].isDefault = true
    }
    return valid
  } catch {
    return [fallbackPersona]
  }
}

export function getDefaultPersona(personas) {
  return personas.find(p => p.isDefault) || personas[0] || fallbackPersona
}

export function buildPersonaContext(persona) {
  if (!persona || persona.id === 'fallback') return ''
  return `You are operating through the following lens:\n\n${persona.body}`
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const fm = {}
  match[1].split('\n').forEach(line => {
    const idx = line.indexOf(':')
    if (idx > -1) {
      fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
  })
  return fm
}

function stripFrontmatter(content) {
  return content.replace(/^---\n[\s\S]*?\n---\n*/, '')
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

const fallbackPersona = {
  id: 'fallback',
  name: 'Default Researcher',
  context: null,
  isDefault: true,
  isPublic: true,
  body: 'You are a knowledge worker reviewing documents with a focus on clarity, key insights, open questions, and connections to existing knowledge.',
  path: null,
}
