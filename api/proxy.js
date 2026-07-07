export const config = { runtime: 'edge' }

const ANTHROPIC_API    = 'https://api.anthropic.com/v1/messages'
const GITHUB_MODELS_API = 'https://models.inference.ai.azure.com/chat/completions'

// Translate Anthropic SSE → OpenAI SSE so the frontend is provider-agnostic
function translateAnthropicStream(readable) {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  let buf = ''

  return readable.pipeThrough(new TransformStream({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()                          // keep incomplete line in buffer
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (raw === '[DONE]') { ctrl.enqueue(enc.encode('data: [DONE]\n\n')); continue }
        try {
          const j = JSON.parse(raw)
          if (j.type === 'content_block_delta' && j.delta?.text) {
            const out = { choices: [{ delta: { content: j.delta.text } }] }
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify(out)}\n\n`))
          }
        } catch {}
      }
    },
    flush(ctrl) {
      ctrl.enqueue(enc.encode('data: [DONE]\n\n'))
    },
  }))
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const apiKey = req.headers.get('x-api-key')
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: { message: 'Missing x-api-key header' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    )
  }

  let body
  try { body = await req.json() } catch {
    return new Response(
      JSON.stringify({ error: { message: 'Invalid JSON body' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const SSE_HEADERS = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  }

  // ── Anthropic ──────────────────────────────────────────────────────────────
  if (apiKey.startsWith('sk-ant-')) {
    const systemMsg  = body.messages?.find(m => m.role === 'system')
    const userMsgs   = body.messages?.filter(m => m.role !== 'system') ?? []

    const anthropicBody = {
      model:      'claude-sonnet-4-6',
      max_tokens: body.max_tokens ?? 8192,
      stream:     true,
      ...(systemMsg && { system: systemMsg.content }),
      messages: userMsgs,
    }

    const upstream = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody),
    })

    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}))
      return new Response(JSON.stringify(err), {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response(translateAnthropicStream(upstream.body), { headers: SSE_HEADERS })
  }

  // ── GitHub Models (OpenAI-compatible, pass-through) ────────────────────────
  const upstream = await fetch(GITHUB_MODELS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })

  if (!upstream.ok) {
    const err = await upstream.json().catch(() => ({}))
    return new Response(JSON.stringify(err), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(upstream.body, { headers: SSE_HEADERS })
}
