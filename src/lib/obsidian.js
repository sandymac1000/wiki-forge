const BASE = '/obsidian'
const TOKEN = import.meta.env.VITE_OBSIDIAN_TOKEN

const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
}

export async function listVault(path = '') {
  const res = await fetch(`${BASE}/vault/${path}`, { headers })
  if (!res.ok) throw new Error(`Vault list failed: ${res.status}`)
  return res.json()
}

export async function readFile(path) {
  const res = await fetch(`${BASE}/vault/${path}`, { headers })
  if (!res.ok) throw new Error(`Read failed: ${res.status}`)
  return res.text()
}

export async function writeFile(path, content) {
  const res = await fetch(`${BASE}/vault/${path}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'text/markdown' },
    body: content,
  })
  if (!res.ok) throw new Error(`Write failed: ${res.status}`)
  return res
}

export async function deleteFile(path) {
  const res = await fetch(`${BASE}/vault/${path}`, {
    method: 'DELETE',
    headers,
  })
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`)
  return res
}

export async function updateFrontmatter(path, updates) {
  const content = await readFile(path)
  const updated = mergeFrontmatter(content, updates)
  return writeFile(path, updated)
}

function mergeFrontmatter(content, updates) {
  const fmRegex = /^---\n([\s\S]*?)\n---/
  const match = content.match(fmRegex)
  if (!match) {
    const fm = Object.entries(updates).map(([k, v]) => `${k}: ${v}`).join('\n')
    return `---\n${fm}\n---\n\n${content}`
  }
  let fmBlock = match[1]
  Object.entries(updates).forEach(([key, val]) => {
    const lineReg = new RegExp(`^${key}:.*$`, 'm')
    const line = `${key}: ${val}`
    if (lineReg.test(fmBlock)) {
      fmBlock = fmBlock.replace(lineReg, line)
    } else {
      fmBlock += `\n${line}`
    }
  })
  return content.replace(fmRegex, `---\n${fmBlock}\n---`)
}

export function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const fm = {}
  match[1].split('\n').forEach(line => {
    const idx = line.indexOf(':')
    if (idx > -1) {
      const key = line.slice(0, idx).trim()
      const val = line.slice(idx + 1).trim()
      fm[key] = val === 'null' ? null : val
    }
  })
  return fm
}

export function stripFrontmatter(content) {
  return content.replace(/^---\n[\s\S]*?\n---\n*/, '')
}