export const config = { runtime: 'edge' }

const GITHUB_MODELS_API = 'https://models.inference.ai.azure.com/chat/completions'

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
  try {
    body = await req.json()
  } catch {
    return new Response(
      JSON.stringify({ error: { message: 'Invalid JSON body' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const upstream = await fetch(GITHUB_MODELS_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!upstream.ok) {
    const error = await upstream.json().catch(() => ({}))
    return new Response(JSON.stringify(error), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
}
