import { useState, useRef, useCallback, useEffect } from 'react'
import MarkdownRenderer from './components/MarkdownRenderer.jsx'
import GitHubModal from './components/GitHubModal.jsx'
import { OBJECT_DOC_PROMPT } from './constants/systemPrompt.js'
import './App.css'

const COOKIE_NAME = 'plsql_api_key'
const COOKIE_DAYS = 30

const getCookie = (name) => {
  const match = document.cookie.match(new RegExp(`(^| )${name}=([^;]+)`))
  return match ? decodeURIComponent(match[2]) : ''
}

const setCookie = (name, value, days) => {
  const expires = new Date(Date.now() + days * 864e5).toUTCString()
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Strict`
}

const deleteCookie = (name) => {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Strict`
}

// GitHub Models: 8K total token budget (input + output combined).
// OBJECT_DOC_PROMPT ≈ 450 tokens + 8K-char object ≈ 2500 tokens input → ~5100 tokens for output.
// Anthropic never slices (200K context handles any single object).
const CHUNK_GITHUB    = 8000
const TOTAL_BUDGET_GH = 7600   // 8K minus safety margin

// Subdivide a string into pieces of at most maxLen chars (fallback for oversized objects)
function sliceAt(str, maxLen) {
  const pieces = []
  for (let i = 0; i < str.length; i += maxLen) pieces.push(str.slice(i, i + maxLen))
  return pieces
}

// Blank out string literals and comments (keeping length/offsets intact) so object
// detection never anchors on a CREATE PROCEDURE mentioned inside a comment or a
// dynamic-SQL string literal.
function maskNonCode(code) {
  return code.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
}

const OBJECT_HEADER_RE = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE(?:\s+BODY)?|TRIGGER|TYPE)\b/gi

// Detects each PROCEDURE/FUNCTION declared directly inside a PACKAGE BODY (siblings, not
// locally-nested helpers) via a lightweight block-depth scan, so a package with N members
// becomes N individual AI calls instead of one call for the whole body. Returns null if the
// body can't be reliably balanced (unbalanced BEGIN/END, malformed code, etc.) — callers must
// then fall back to sending the whole PACKAGE BODY as a single object, which is always safe.
function splitPackageBodyMembers(bodyCode) {
  const masked = maskNonCode(bodyCode)
  const HEADER_RE = /\b(PROCEDURE|FUNCTION)\s+(\w+)/gi

  const headers = []
  let hm
  while ((hm = HEADER_RE.exec(masked)) !== null) headers.push({ index: hm.index, type: hm[1].toUpperCase(), name: hm[2] })
  if (headers.length === 0) return null

  // Finds the index right after the `;` that closes the subprogram starting at startIdx.
  // Any PROCEDURE/FUNCTION found before our own BEGIN is a locally-nested helper declared in
  // the declare section — its whole span (recursively) is consumed first so its internal
  // BEGIN/END pair is never mistaken for ours.
  const findBlockEnd = (startIdx) => {
    let depth = 0, seenBegin = false
    const scan = /\b(PROCEDURE|FUNCTION|BEGIN|CASE|IF|LOOP|END\s*(?:IF|CASE|LOOP)?)\b/gi
    scan.lastIndex = startIdx
    let first = true
    let tm
    while ((tm = scan.exec(masked)) !== null) {
      const tok = tm[0].toUpperCase().replace(/\s+/g, ' ').trim()
      if (first) { first = false; continue } // skip our own header keyword
      if (tok === 'PROCEDURE' || tok === 'FUNCTION') {
        if (seenBegin) continue // nested local block inside our own executable section — ignore
        const nestedEnd = findBlockEnd(tm.index)
        if (nestedEnd === -1) {
          const semi = masked.indexOf(';', tm.index) // forward declaration with no body
          if (semi === -1) return -1
          scan.lastIndex = semi + 1
        } else {
          scan.lastIndex = nestedEnd
        }
        continue
      }
      if (tok === 'BEGIN') { depth++; seenBegin = true }
      else if (tok === 'CASE' || tok === 'IF' || tok === 'LOOP') depth++
      else if (tok === 'END IF' || tok === 'END CASE' || tok === 'END LOOP') depth--
      else if (tok === 'END') {
        depth--
        if (seenBegin && depth <= 0) {
          const semi = masked.indexOf(';', scan.lastIndex)
          return semi === -1 ? masked.length : semi + 1
        }
      }
    }
    return -1
  }

  const members = []
  let cursor = 0
  for (const h of headers) {
    if (h.index < cursor) continue
    const end = findBlockEnd(h.index)
    if (end === -1) return null
    const memberCode = bodyCode.slice(h.index, end)
    // Sanity check: the closing END must be anonymous or name the member itself. If it names
    // something else (e.g. the package's own closing END got swallowed because this member's
    // real END was missing/malformed), the whole scan is unreliable — bail to the safe fallback.
    const closingName = /\bEND\s+(\w+)\s*;\s*$/i.exec(maskNonCode(memberCode))?.[1]
    if (closingName && closingName.toUpperCase() !== h.name.toUpperCase()) return null
    members.push({ type: h.type, name: h.name, code: memberCode })
    cursor = end
  }
  return members
}

// Split code into one element per PL/SQL object (PROCEDURE, FUNCTION, PACKAGE, TRIGGER, TYPE).
// Detection runs against a masked copy so comments/string literals can't trigger a false split,
// but the actual pieces are sliced from the original code so nothing is lost. Any content before
// the first CREATE (file header comments, etc.) has no object to attach to and is dropped rather
// than sent to the AI as a fake "object with no header". A PACKAGE BODY is further exploded into
// one piece per member (see splitPackageBodyMembers) so each PROCEDURE/FUNCTION inside gets its
// own isolated documentation call, same as a top-level object.
function splitByObject(code) {
  const masked = maskNonCode(code)
  const indices = []
  let m
  OBJECT_HEADER_RE.lastIndex = 0
  while ((m = OBJECT_HEADER_RE.exec(masked)) !== null) indices.push(m.index)
  if (indices.length === 0) return [code]

  const rawParts = indices.map((start, k) => {
    const end = k + 1 < indices.length ? indices[k + 1] : code.length
    return code.slice(start, end)
  }).filter(p => p.trim())

  const parts = []
  for (const piece of rawParts) {
    const bodyMatch = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?PACKAGE\s+BODY\s+(\w+)/i.exec(piece)
    const members = bodyMatch ? splitPackageBodyMembers(piece) : null
    if (bodyMatch && members && members.length > 0) {
      members.forEach(mem => {
        parts.push(`-- Miembro del PACKAGE BODY ${bodyMatch[1]}\nCREATE OR REPLACE ${mem.code.trim()}`)
      })
    } else {
      parts.push(piece)
    }
  }
  return parts.length > 0 ? parts : [code]
}

// Extract object type + name pairs by delegating to splitByObject, so the manifest always
// reflects exactly how the file was decomposed (including exploded PACKAGE BODY members).
function extractManifest(code) {
  return splitByObject(code)
    .map(piece => {
      const m = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION|PACKAGE(?:\s+BODY)?|TRIGGER|TYPE)\s+(\w+)/i.exec(maskNonCode(piece))
      return m ? { type: m[1].replace(/\s+/g, ' ').toUpperCase(), name: m[2] } : null
    })
    .filter(Boolean)
}

// Build the per-object documentation request message
function buildUserMessage(fileName, objCode, objIndex, totalObjects, fullManifest, pieceLabel = '') {
  const lines = [`**Archivo:** \`${fileName || 'codigo.sql'}\``]

  if (fullManifest.length > 0) {
    lines.push('', `## Inventario completo del archivo (${fullManifest.length} objetos)`)
    fullManifest.forEach((o, i) => lines.push(`${i + 1}. **${o.type}** → \`${o.name}\``))
  }

  if (totalObjects > 1) {
    const detected = extractManifest(objCode)
    const label = detected.length > 0 ? detected.map(o => `${o.type} \`${o.name}\``).join(', ') : 'fragmento sin cabecera CREATE'
    lines.push('', `## Objeto ${objIndex + 1} de ${totalObjects}${pieceLabel} — ${label}`)
  }

  if (pieceLabel) {
    lines.push('', `> ⚠️ **Fragmento parcial:** este bloque es una porción del objeto completo, dividida por el límite de tokens del proveedor. El código puede no empezar o terminar en un límite lógico (p. ej. a mitad de un procedimiento). Documenta únicamente lo que puedas inferir con certeza de este fragmento; no inventes las partes faltantes, y si la sección de Notas Técnicas aplica, menciona que el análisis es parcial.`)
  }

  lines.push('', '## Código PL/SQL', '', '```sql', objCode, '```')
  return lines.join('\n')
}

// Build the final index/summary request message
function buildIndexMessage(fileName, fullCode, manifest, isAnthropic) {
  const lines = [`**Archivo:** \`${fileName || 'codigo.sql'}\``, '']
  lines.push(`## Objetos documentados (${manifest.length} en total)`)
  manifest.forEach((o, i) => lines.push(`${i + 1}. **${o.type}** → \`${o.name}\``))
  // Anthropic: send full code so the model can derive accurate dependency relationships
  // GitHub Models: manifest only — budget doesn't allow full code in this request
  if (isAnthropic && fullCode) {
    lines.push('', '## Código fuente completo (para análisis de dependencias)', '', '```sql', fullCode, '```')
  }
  return lines.join('\n')
}

export default function App() {
  // ── State ────────────────────────────────────────────────────────────────
  const [apiKey, setApiKey]           = useState(() => getCookie(COOKIE_NAME))
  const [apiKeyVisible, setApiKeyVis] = useState(false)
  const [apiKeyValid, setApiKeyValid] = useState(null)   // null | true | false
  const [code, setCode]               = useState('')
  const [fileName, setFileName]       = useState('')
  const [markdown, setMarkdown]       = useState('')
  const [phase, setPhase]             = useState('idle') // idle | analyzing | streaming | done | error
  const [errorMsg, setErrorMsg]       = useState('')
  const [activeTab, setActiveTab]     = useState('preview')
  const [copied, setCopied]           = useState(false)
  const [dragOver, setDragOver]       = useState(false)
  const [stats, setStats]             = useState({ procedures: 0, functions: 0, lines: 0 })
  const [tokenCount, setTokenCount]   = useState(0)
  const [elapsedTime, setElapsedTime] = useState(0)
  const [showGitHub, setShowGitHub]   = useState(false)
  const [isMobile, setIsMobile]       = useState(false)
  const [mobileView, setMobileView]   = useState('editor')

  const fileInputRef = useRef(null)
  const previewRef   = useRef(null)
  const abortRef     = useRef(null)
  const timerRef     = useRef(null)
  const startRef     = useRef(null)

  // ── Responsive detection ─────────────────────────────────────────────────
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // ── Persist API key ──────────────────────────────────────────────────────
  useEffect(() => {
    if (apiKey) setCookie(COOKIE_NAME, apiKey, COOKIE_DAYS)
    else deleteCookie(COOKIE_NAME)
  }, [apiKey])

  // ── Code stats ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!code) { setStats({ procedures: 0, functions: 0, lines: 0 }); return }
    setStats({
      procedures: (code.match(/\bPROCEDURE\b/gi) || []).length,
      functions:  (code.match(/\bFUNCTION\b/gi)  || []).length,
      lines:      code.split('\n').length,
    })
  }, [code])

  // ── File reading ─────────────────────────────────────────────────────────
  const readFile = (file) => {
    if (!file) return
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = e => setCode(e.target.result)
    reader.readAsText(file, 'UTF-8')
  }

  const handleDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false)
    if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0])
  }, [])

  // ── API Key validation ───────────────────────────────────────────────────
  const validateApiKey = async () => {
    const isAnthropic = apiKey.startsWith('sk-ant-')
    const isGitHub    = apiKey.startsWith('ghp_') || apiKey.startsWith('github_pat_')
    if (!isAnthropic && !isGitHub) { setApiKeyValid(false); return }
    try {
      const r = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 5,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
      setApiKeyValid(r.status !== 401 && r.status !== 403)
    } catch { setApiKeyValid(false) }
  }

  // ── Analyze + stream ─────────────────────────────────────────────────────
  const handleAnalyze = async () => {
    if (!code.trim() || !apiKey.trim()) return
    setPhase('analyzing'); setMarkdown(''); setErrorMsg('')
    setTokenCount(0); setElapsedTime(0)
    startRef.current = Date.now()
    timerRef.current = setInterval(() => setElapsedTime(Math.floor((Date.now() - startRef.current) / 1000)), 500)
    if (isMobile) setMobileView('output')
    abortRef.current = new AbortController()

    const isAnthropic  = apiKey.startsWith('sk-ant-')
    // OBJECT_DOC_PROMPT contains no mention of index/summary by design,
    // preventing the model from generating them per-object.
    const objSysPrompt = OBJECT_DOC_PROMPT

    const objects      = splitByObject(code)
    const fullManifest = extractManifest(code)

    // Each completed request's full text lands here as its own entry — the final
    // Markdown is just these sections joined with a separator, so a partial/garbled
    // response from one object can never bleed into the text of another, and a
    // retried object simply replaces its own entry instead of redoing everything.
    const sections = []
    let t = 0
    const renderMarkdown = (liveText) => [...sections, ...(liveText !== undefined ? [liveText] : [])].join('\n\n---\n\n')

    // Streams one SSE response and returns its fully assembled text. Buffers any
    // incomplete trailing line across reads() calls (a `data: {...}` JSON payload can
    // be split across two network reads) so a chunk boundary can never silently drop
    // or corrupt part of the response — mirrors the buffering api/proxy.js already
    // does server-side for the Anthropic→OpenAI SSE translation.
    const streamResp = async (resp, onUpdate) => {
      const reader = resp.body.getReader()
      const dec = new TextDecoder()
      let text = '', buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() // keep the incomplete trailing line for the next read
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const d = line.slice(6).trim()
          if (d === '[DONE]') continue
          try {
            const j = JSON.parse(d)
            const delta = j.choices?.[0]?.delta?.content
            if (delta) {
              text += delta; t++
              onUpdate(text); setTokenCount(t * 4)
              if (previewRef.current) previewRef.current.scrollTop = previewRef.current.scrollHeight
            }
          } catch {}
        }
      }
      return text
    }

    // Build and send one proxy request
    const callProxy = async (systemContent, userContent, maxOut) => {
      const estimatedInput  = Math.ceil((systemContent.length + userContent.length) / 3.5)
      const maxOutputTokens = isAnthropic
        ? maxOut
        : Math.max(256, TOTAL_BUDGET_GH - estimatedInput)

      if (!isAnthropic && estimatedInput >= TOTAL_BUDGET_GH) {
        throw new Error(`Objeto demasiado grande para GitHub Models (${estimatedInput} tokens est.). Usa una key de Anthropic para archivos de este tamano.`)
      }

      return fetch('/api/proxy', {
        method: 'POST',
        signal: abortRef.current.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
          model: isAnthropic ? 'claude-sonnet-4-6' : 'gpt-4o',
          max_tokens: maxOutputTokens,
          stream: true,
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user',   content: userContent   },
          ],
        }),
      })
    }

    // Sends a request and, if the provider replies with a rate-limit error, waits and
    // retries automatically instead of aborting the whole multi-object run — a package
    // with many members can legitimately burn through a per-minute token quota partway
    // through. Any other error (e.g. object too large for the provider's budget) is not
    // retried since waiting wouldn't help.
    const RATE_LIMIT_MAX_ATTEMPTS = 3
    const requestWithRetry = async (systemContent, userContent, maxOut) => {
      for (let attempt = 1; attempt <= RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
        const resp = await callProxy(systemContent, userContent, maxOut)
        if (resp.ok) return resp
        const e = await resp.json().catch(() => ({}))
        const message = e?.error?.message || `HTTP ${resp.status}`
        const rateLimited = resp.status === 429 || /rate limit/i.test(message)
        if (!rateLimited || attempt === RATE_LIMIT_MAX_ATTEMPTS) throw new Error(message)
        const waitSec = parseInt(/(\d+)\s*seconds?/i.exec(message)?.[1], 10) || 60
        setErrorMsg(`⏳ ${message} — reintentando automáticamente (intento ${attempt}/${RATE_LIMIT_MAX_ATTEMPTS})`)
        await new Promise(r => setTimeout(r, waitSec * 1000))
        setErrorMsg('')
      }
    }

    try {
      // ── Phase 1: one isolated request per PL/SQL object ──────────────────
      for (let oi = 0; oi < objects.length; oi++) {
        const objCode = objects[oi]

        // A single oversized object (e.g. a very large PACKAGE BODY) is split
        // into pieces only as a last resort for GitHub Models' token budget.
        const pieces = (!isAnthropic && objCode.length > CHUNK_GITHUB)
          ? sliceAt(objCode, CHUNK_GITHUB)
          : [objCode]

        for (let pi = 0; pi < pieces.length; pi++) {
          // Show the trailing separator immediately (a no-op if `sections` is still
          // empty) so the preview visibly opens a new block while the request is
          // still in flight, matching the previous eager-divider UX.
          setMarkdown(renderMarkdown(''))

          const pieceLabel  = pieces.length > 1 ? ` — parte ${pi + 1} de ${pieces.length}` : ''
          const userContent = buildUserMessage(fileName, pieces[pi], oi, objects.length, fullManifest, pieceLabel)
          const resp        = await requestWithRetry(objSysPrompt, userContent, 8192)
          setPhase('streaming')
          const text = await streamResp(resp, partial => setMarkdown(renderMarkdown(partial)))
          sections.push(text)
        }
      }

      // ── Phase 2: executive index as a separate, focused request ──────────
      // Sending the index as its own request (with the full manifest as context)
      // ensures no object hallucination bleeds in from earlier context.
      setMarkdown(renderMarkdown(''))

      const indexSysPrompt = `Eres un experto documentador PL/SQL Oracle. Genera UNICAMENTE el INDICE GENERAL del wiki en Markdown en espanol. No documentes objetos individuales.

Estructura exacta:

# 📚 INDICE GENERAL DEL WIKI

## Resumen Ejecutivo
[2-3 parrafos: que sistema o modulo representa este codigo, que procesos de negocio cubre, area (RRHH/Finanzas/Logistica/etc.), flujo de alto nivel entre objetos]

---

## Tabla de Contenidos
| # | Objeto | Tipo | Proposito resumido (max. 12 palabras) | Complejidad |
|---|--------|------|---------------------------------------|-------------|

---

## Diagrama de Dependencias
\`\`\`
[Nombre del sistema]
├── OBJETO_1 ──→ tabla_a, tabla_b
├── OBJETO_2 ──→ OBJETO_1, tabla_c
└── OBJETO_3 ──→ tabla_d (TRIGGER)
\`\`\`

---

## Glosario de Terminos
| Termino tecnico | Significado para el negocio |
|-----------------|----------------------------|`

      const indexUser = buildIndexMessage(fileName, code, fullManifest, isAnthropic)
      const indexResp = await requestWithRetry(indexSysPrompt, indexUser, 4096)
      const indexText = await streamResp(indexResp, partial => setMarkdown(renderMarkdown(partial)))
      sections.push(indexText)

      setPhase('done')
    } catch (err) {
      if (err.name !== 'AbortError') { setErrorMsg(`❌ ${err.message}`); setPhase('error') }
      else setPhase(sections.length > 0 ? 'done' : 'idle')
    } finally {
      clearInterval(timerRef.current)
    }
  }

  const handleStop     = () => { abortRef.current?.abort(); clearInterval(timerRef.current) }
  const handleReset    = () => { clearInterval(timerRef.current); setPhase('idle'); setMarkdown(''); setErrorMsg(''); setTokenCount(0); setElapsedTime(0); if (isMobile) setMobileView('editor') }
  const handleCopy     = () => { navigator.clipboard.writeText(markdown); setCopied(true); setTimeout(() => setCopied(false), 2000) }
  const handleDownload = () => {
    const name = (fileName || 'plsql-wiki').replace(/\.sql$/i, '')
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' })), download: `${name}.md` })
    a.click(); URL.revokeObjectURL(a.href)
  }

  const isRunning = phase === 'analyzing' || phase === 'streaming'
  const hasOutput = markdown.length > 0
  const progress  = phase === 'done' ? 100 : phase === 'analyzing' ? 12 : phase === 'streaming' ? Math.min(12 + (tokenCount / 320) * 88, 98) : 0

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="app-shell">
      {showGitHub && <GitHubModal markdown={markdown} fileName={fileName} onClose={() => setShowGitHub(false)} />}

      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <header className="header">
        <div className="header-logo">
          <div className="logo-icon">⚡</div>
          {!isMobile && (
            <div>
              <div className="logo-title">PL/SQL <span>DocAgent</span></div>
              <div className="logo-sub">Wiki BY (csvelasquez) <span className="version-badge">v{__APP_VERSION__}</span></div>
            </div>
          )}
          {isMobile && <span className="logo-title-mobile">DocAgent</span>}
        </div>

        <div className="header-apikey">
          <div className="apikey-wrap">
            <span className="apikey-icon">🔑</span>
            <input
              type={apiKeyVisible ? 'text' : 'password'}
              value={apiKey}
              onChange={e => { setApiKey(e.target.value); setApiKeyValid(null) }}
              placeholder={isMobile ? 'sk-ant-... o ghp_...' : 'sk-ant-api03-... ó ghp_...'}
              className={`apikey-input ${apiKeyValid === true ? 'valid' : apiKeyValid === false ? 'invalid' : ''}`}
            />
            <button onClick={() => setApiKeyVis(v => !v)} className="apikey-toggle">
              {apiKeyVisible ? '🙈' : '👁'}
            </button>
          </div>
          <button
            className={`btn btn-verify ${apiKeyValid === true ? 'valid' : ''}`}
            onClick={validateApiKey}
            disabled={!apiKey || isRunning}
          >
            {apiKeyValid === true ? '✅' : apiKeyValid === false ? '❌' : isMobile ? '✓' : 'Verificar'}
          </button>
          {apiKeyValid === false && !isMobile && (
            <a href={apiKey.startsWith('sk-ant-') ? 'https://console.anthropic.com/settings/keys' : 'https://github.com/settings/tokens'} target="_blank" rel="noreferrer" className="get-key-link">Obtener →</a>
          )}
        </div>
      </header>

      {/* ── MOBILE TAB BAR ─────────────────────────────────────────────── */}
      {isMobile && (
        <div className="mobile-tabs">
          {[{ id: 'editor', label: '📝 Editor' }, { id: 'output', label: '📄 Resultado' }].map(t => (
            <button key={t.id} onClick={() => setMobileView(t.id)} className={`mobile-tab ${mobileView === t.id ? 'active' : ''}`}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* ── BODY ────────────────────────────────────────────────────────── */}
      <div className="body">

        {/* ── LEFT PANEL ── */}
        <aside className={`panel-left ${isMobile && mobileView !== 'editor' ? 'hidden' : ''}`}>

          {/* Upload */}
          <div className="upload-zone-wrap">
            <div
              className={`drop-zone ${dragOver ? 'drag-over' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input ref={fileInputRef} type="file" accept=".sql,.pls,.plsql,.pkb,.pks,.pck,.trg,.fnc,.prc,.typ" onChange={e => { if (e.target.files[0]) readFile(e.target.files[0]) }} />
              <div className="drop-icon">{fileName ? '📄' : '📁'}</div>
              {fileName ? (
                <div>
                  <div className="drop-filename">{fileName}</div>
                  <div className="drop-meta">{stats.lines} líneas · {stats.procedures} PROC · {stats.functions} FUNC</div>
                </div>
              ) : (
                <div>
                  <div className="drop-hint">Arrastra tu .sql o haz clic aquí</div>
                  <div className="drop-exts">.sql · .pls · .plsql · .pkb · .prc · .fnc</div>
                </div>
              )}
            </div>
          </div>

          {/* Editor label */}
          <div className="editor-label-row">
            <span className="section-label">Editor PL/SQL</span>
            {code && <button className="btn-clear" onClick={() => { setCode(''); setFileName('') }}>🗑 limpiar</button>}
          </div>

          {/* Code textarea */}
          <div className="code-editor">
            <div className="line-numbers">
              {(code || '').split('\n').map((_, idx) => (
                <div key={idx} className="line-num">{idx + 1}</div>
              ))}
            </div>
            <textarea
              value={code}
              onChange={e => { setCode(e.target.value); if (!fileName) setFileName('codigo.sql') }}
              placeholder={'-- Pega tu código PL/SQL aquí\n-- o arrastra un archivo .sql\n\nCREATE OR REPLACE PROCEDURE ...'}
              className="code-textarea"
              spellCheck={false}
            />
          </div>

          {/* Stats chips */}
          {code && (
            <div className="stats-row">
              {[{ icon: '📝', v: stats.lines, l: 'L' }, { icon: '📦', v: stats.procedures, l: 'proc' }, { icon: '⚙️', v: stats.functions, l: 'func' }, { icon: '💾', v: `${(new Blob([code]).size / 1024).toFixed(1)}`, l: 'KB' }].map((s, i) => (
                <div key={i} className="stat-chip"><span>{s.icon}</span><strong>{s.v}</strong><span>{s.l}</span></div>
              ))}
            </div>
          )}

          {/* Error */}
          {errorMsg && <div className="error-box">{errorMsg}</div>}

          {/* Progress */}
          {(isRunning || phase === 'done') && (
            <div className="progress-wrap">
              <div className="progress-labels">
                <span className="progress-status">
                  {phase === 'analyzing' ? '🔍 Analizando...' : phase === 'streaming' ? '⚡ Generando...' : '✅ Listo'}
                </span>
                <span className="progress-pct">{Math.round(progress)}% · {elapsedTime}s</span>
              </div>
              <div className="progress-track">
                <div className={`progress-fill ${isRunning ? 'shine' : 'done'}`} style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {/* Action */}
          <div className="action-row">
            {!isRunning ? (
              <button
                className={`btn btn-main ${phase === 'done' ? 'success' : ''}`}
                onClick={phase === 'done' ? handleReset : handleAnalyze}
                disabled={phase !== 'done' && !code.trim()}
              >
                {phase === 'done' ? '🔄 Nueva Doc' : '⚡ Analizar y Documentar'}
              </button>
            ) : (
              <>
                <button className="btn btn-loading" disabled>
                  <div className="spinner" />
                  {phase === 'analyzing' ? 'Analizando...' : 'Generando...'}
                </button>
                <button className="btn btn-stop" onClick={handleStop}>⏹</button>
              </>
            )}
          </div>
        </aside>

        {/* ── RIGHT PANEL ── */}
        <main className={`panel-right ${isMobile && mobileView !== 'output' ? 'hidden' : ''}`}>

          {/* Toolbar */}
          <div className="output-toolbar">
            <div className="output-tabs">
              {[{ id: 'preview', icon: '👁', label: 'Preview' }, { id: 'raw', icon: '📝', label: 'Raw MD' }].map(tab => (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}>
                  {tab.icon}{!isMobile && ` ${tab.label}`}
                </button>
              ))}
            </div>
            {hasOutput && (
              <div className="output-actions">
                <button className={`btn btn-action ${copied ? 'copied' : ''}`} onClick={handleCopy}>
                  {copied ? '✅' : '📋'}{!isMobile && (copied ? ' Copiado!' : ' Copiar')}
                </button>
                <button className="btn btn-action download" onClick={handleDownload}>
                  ⬇️{!isMobile && ' .md'}
                </button>
                <button className="btn btn-action github" onClick={() => setShowGitHub(true)}>
                  🐙{!isMobile && ' GitHub'}
                </button>
              </div>
            )}
          </div>

          {/* Output */}
          <div ref={previewRef} className="output-content">

            {/* IDLE */}
            {phase === 'idle' && !hasOutput && (
              <div className="idle-state">
                <div className="idle-icon">📋</div>
                <div className="idle-title">Tu wiki aparecerá aquí</div>
                <div className="idle-steps">
                  <div>1️⃣ Carga tu <span>.sql</span> o pega el código</div>
                  <div>2️⃣ Presiona <span>⚡ Analizar y Documentar</span></div>
                  <div>3️⃣ Publica en <span className="green">🐙 GitHub</span> con un clic</div>
                </div>
                <div className="idle-features">
                  {['📦 Procedures','⚙️ Functions','📥 Parámetros','💻 SQL Examples','⚠️ Errors','🗄️ Dependencies','📊 Complexity','📚 Wiki Index'].map((f, i) => (
                    <div key={i} className="feature-chip" style={{ animationDelay: `${i * 0.06}s` }}>{f}</div>
                  ))}
                </div>
              </div>
            )}

            {/* ANALYZING */}
            {phase === 'analyzing' && (
              <div className="analyzing-state">
                <div className="spinner-rings">
                  {[0,1,2].map(ri => <div key={ri} className={`ring ring-${ri}`} />)}
                  <div className="ring-icon">🔍</div>
                </div>
                <div className="analyzing-title">Analizando......</div>
                <div className="analyzing-steps">
                  {['Detectando PROCEDUREs y FUNCTIONs','Analizando parámetros y tipos','Evaluando lógica de negocio','Identificando dependencias','Calculando complejidad'].map((step, i) => (
                    <div key={i} className="analyzing-step" style={{ animationDelay: `${i * 0.15}s` }}>
                      <div className="step-dot" />{step}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* PREVIEW */}
            {(phase === 'streaming' || phase === 'done' || (phase === 'error' && hasOutput)) && activeTab === 'preview' && (
              <div className="preview-content">
                <div className={phase === 'streaming' ? 'cursor-blink' : ''}>
                  <MarkdownRenderer text={markdown} />
                </div>
              </div>
            )}

            {/* RAW */}
            {(phase === 'streaming' || phase === 'done' || (phase === 'error' && hasOutput)) && activeTab === 'raw' && (
              <pre className="raw-content">
                {markdown}{phase === 'streaming' && <span className="cursor-blink" />}
              </pre>
            )}
          </div>

          {/* Footer */}
          <div className="output-footer">
            <div className="footer-stats">
              {[
                { icon: '📊', v: hasOutput ? `${markdown.split('\n').length}L` : '—' },
                { icon: '🔤', v: hasOutput ? `${(markdown.length/1024).toFixed(1)}KB` : '—' },
                { icon: '⏱', v: elapsedTime > 0 ? `${elapsedTime}s` : '—' },
              ].map((s, i) => <span key={i} className="footer-stat">{s.icon} {s.v}</span>)}
            </div>
            <div className="footer-status">
              <div className={`status-dot ${phase === 'done' ? 'done' : isRunning ? 'running' : ''}`} />
              <span className={`status-text ${phase === 'done' ? 'done' : isRunning ? 'running' : ''}`}>
                {phase === 'done' ? '✓ GitHub Wiki Ready' : isRunning ? 'Processing...' : apiKey.startsWith('sk-ant-') ? 'claude-sonnet-4-6' : 'gpt-4o'}
              </span>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
