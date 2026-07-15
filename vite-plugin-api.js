// Serves api/proxy.js's handler directly from Vite's own dev/preview server, so local
// testing never depends on the Vercel CLI (`vercel dev`) or an actual Vercel deployment.
// api/proxy.js already exports a standard Web `Request -> Response` handler (it's written
// for the Vercel Edge runtime, which uses that exact Web-standard interface) — Node 18+ has
// global Request/Response/Headers/ReadableStream natively, so the handler runs completely
// unmodified here. This plugin's only job is bridging Vite's Node-style (req, res) middleware
// signature to that Web-standard handler and back, streaming the response through untouched
// so SSE (the whole point of this endpoint) keeps working chunk-by-chunk, not buffered.
async function handleApiProxy(req, res) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const bodyBuffer = Buffer.concat(chunks)

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }

  const webRequest = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : bodyBuffer,
  })

  const { default: handler } = await import('./api/proxy.js')
  const webResponse = await handler(webRequest)

  res.statusCode = webResponse.status
  webResponse.headers.forEach((value, key) => res.setHeader(key, value))

  if (!webResponse.body) { res.end(); return }
  const reader = webResponse.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(value)
  }
  res.end()
}

// The frontend does `resp.json()` on any non-ok response and reads `.error.message` (see
// requestWithRetry in App.jsx) — the same shape api/proxy.js itself returns for upstream
// errors. A plain-text body here would silently fail that parse and fall back to a generic
// "HTTP 500" with no real information, hiding exactly the detail needed to diagnose a local
// dev-only failure (corporate proxy, DNS, TLS interception, etc.).
//
// Node/undici's fetch() wraps any lower-level network failure in a generic
// `TypeError: fetch failed` — the actually useful detail (ENOTFOUND, ECONNREFUSED, a TLS
// certificate error, a proxy needing configuration, ...) lives in `err.cause`, not
// `err.message`. Walk the cause chain so that detail isn't silently dropped.
// These specific codes mean Node's TLS stack rejected a certificate it doesn't trust — by
// far the most common cause on a corporate machine is a proxy doing TLS inspection (it
// intercepts HTTPS and re-signs traffic with its own root cert, which Node correctly refuses
// to trust unless told to). Node is doing the right thing here — the fix is telling it about
// that corporate root CA, not disabling certificate validation.
const TLS_TRUST_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED',
])

function describeError(err) {
  const parts = []
  let cur = err
  const seen = new Set()
  let tlsHint = false
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    if (cur.code && TLS_TRUST_CODES.has(cur.code)) tlsHint = true
    parts.push(cur.code ? `${cur.message} (${cur.code})` : (cur.message || String(cur)))
    cur = cur.cause
  }
  let message = parts.join(' <- caused by: ')
  if (tlsHint) {
    message += ' — esto normalmente significa que una red corporativa está interceptando el tráfico HTTPS (inspección TLS). Pide a IT el certificado raíz de la empresa y arranca el servidor con NODE_EXTRA_CA_CERTS apuntando a ese archivo .pem, en vez de deshabilitar la validación de certificados.'
  }
  return message
}

function sendJsonError(res, status, err) {
  if (res.headersSent) { res.end(); return } // failed mid-stream, headers already committed
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ error: { message: describeError(err) } }))
}

export default function apiProxyPlugin() {
  return {
    name: 'api-proxy',
    configureServer(server) {
      server.middlewares.use('/api/proxy', (req, res) => { handleApiProxy(req, res).catch(err => sendJsonError(res, 500, err)) })
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/proxy', (req, res) => { handleApiProxy(req, res).catch(err => sendJsonError(res, 500, err)) })
    },
  }
}
