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

// Corporate proxy/WAF block pages are mostly <style>/<script>/markup boilerplate with the
// actually identifying text (which security product, what it blocked) buried after all of
// that — truncating the raw markup at a small character limit was cutting off before ever
// reaching it. Strip tags/scripts/styles down to the readable title + body text instead, so
// the identifying part survives even a short limit.
function extractReadableText(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() || ''
  const bodyText = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return title && !bodyText.startsWith(title) ? `${title} — ${bodyText}` : bodyText
}

// A non-ok upstream response is usually a clean JSON error body from the provider's own
// API — but a 403/blocked request can instead come back from something in front of it (a
// corporate proxy's own denial page, a WAF, an edge gateway), typically as HTML or plain
// text. `.json()` on that throws, and silently falling back to `{}` — as this used to do —
// hides the one piece of information (the actual page/message) needed to tell "the provider
// rejected the key" apart from "something on the network blocked this before it ever reached
// the provider". Read the raw text first so that detail is never thrown away.
async function upstreamErrorResponse(upstream) {
  // Distinguish "the body genuinely had nothing in it" from "there was a body but reading/
  // decoding it failed" (e.g. a proxy sending a malformed Content-Encoding) — collapsing both
  // to the same empty string, as the previous version did, throws away which one happened.
  let rawText = '', readErrorMessage = null
  try { rawText = await upstream.text() } catch (readErr) { readErrorMessage = readErr?.message || String(readErr) }

  let err
  try {
    err = JSON.parse(rawText)
  } catch {
    const isHtml = /<html[\s>]|<!doctype html/i.test(rawText)
    const readable = isHtml ? extractReadableText(rawText) : rawText
    if (readable) {
      err = { error: { message: readable.slice(0, 1000) } }
    } else {
      // Nothing readable — surface whatever headers/read-error we do have as a diagnostic
      // trail instead of a bare, unhelpful "empty response".
      const contentLength = upstream.headers.get('content-length')
      const contentType   = upstream.headers.get('content-type')
      const via           = upstream.headers.get('via') || upstream.headers.get('x-cache')
      const details = [
        `HTTP ${upstream.status}`,
        readErrorMessage ? `no se pudo leer el cuerpo (${readErrorMessage})` : 'cuerpo vacío',
        contentLength != null ? `content-length: ${contentLength}` : null,
        contentType ? `content-type: ${contentType}` : null,
        via ? `via/x-cache: ${via}` : null,
      ].filter(Boolean).join(', ')
      err = { error: { message: details } }
    }
  }
  return new Response(JSON.stringify(err), {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  })
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

    if (!upstream.ok) return upstreamErrorResponse(upstream)

    return new Response(translateAnthropicStream(upstream.body), { headers: SSE_HEADERS })
  }

  // ── GitHub Models (OpenAI-compatible, pass-through) ────────────────────────
  const upstream = await fetch(GITHUB_MODELS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })

  if (!upstream.ok) return upstreamErrorResponse(upstream)

  return new Response(upstream.body, { headers: SSE_HEADERS })
}
