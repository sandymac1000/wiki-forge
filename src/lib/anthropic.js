const API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY

export async function runPrompt({ system, user, temperature = 0.7, maxTokens = 2000, onChunk }) {
  const res = await fetch('/anthropic/v1/messages', {
    method: 'POST',
    headers: {
  'Content-Type': 'application/json',
  'x-api-key': API_KEY,
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
},
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      temperature,
      stream: true,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  })

  if (!res.ok) throw new Error(`API error: ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let full = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value)
    const lines = chunk.split('\n').filter(l => l.startsWith('data: '))
    for (const line of lines) {
      const data = line.slice(6)
      if (data === '[DONE]') continue
      try {
        const json = JSON.parse(data)
        if (json.type === 'content_block_delta' && json.delta?.text) {
          full += json.delta.text
          onChunk?.(json.delta.text, full)
        }
      } catch {}
    }
  }
  return full
}