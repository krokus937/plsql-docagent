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

export default function apiProxyPlugin() {
  return {
    name: 'api-proxy',
    configureServer(server) {
      server.middlewares.use('/api/proxy', (req, res) => { handleApiProxy(req, res).catch(err => { res.statusCode = 500; res.end(String(err)) }) })
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/proxy', (req, res) => { handleApiProxy(req, res).catch(err => { res.statusCode = 500; res.end(String(err)) }) })
    },
  }
}
