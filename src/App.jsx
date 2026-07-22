import { useState, useRef, useCallback, useEffect } from 'react'
import MarkdownRenderer from './components/MarkdownRenderer.jsx'
import GitHubModal from './components/GitHubModal.jsx'
import { OBJECT_DOC_PROMPT, OBJECT_DOC_EXTRACT_PROMPT, OBJECT_DOC_SYNTHESIZE_PROMPT } from './constants/systemPrompt.js'
import { stripOuterFence } from './utils/markdown.js'
import './App.css'

const COOKIE_NAME = 'plsql_api_key'
const COOKIE_DAYS = 30

// Called directly from the browser — no backend/proxy involved. Both providers support CORS
// for this: Anthropic requires the anthropic-dangerous-direct-browser-access header (see
// callProvider below), GitHub Models allows it with no special header. models.github.ai
// replaced models.inference.ai.azure.com, which GitHub fully retired 2025-10-17.
const ANTHROPIC_API      = 'https://api.anthropic.com/v1/messages'
const GITHUB_MODELS_API  = 'https://models.github.ai/inference/chat/completions'

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

// GitHub Models free/Copilot Pro/Business tier: input and output tokens are SEPARATE
// per-request budgets — 8000 in / 4000 out — not one shared pool. (Source: GitHub Models
// rate limits, docs.github.com/github-models/prototyping-with-ai-models — Copilot
// Enterprise gets more: 16000 in / 8000 out for "high" models like gpt-4o.) Anthropic never
// slices at all (200K context handles any single object in one shot, so none of this
// applies to it).
//
// Most single objects — even fairly large ones — fit in ONE request under this budget, so
// they're sent whole, exactly like the Anthropic path. Only when an object's code alone
// would exceed the input budget does it get sliced — and even then, only the FIRST piece
// gets the full OBJECT_DOC_PROMPT treatment. Pieces 2+ are genuine sequential continuations:
// each receives a "digest" of everything found in earlier pieces of the SAME object (built
// up as we go, see the Phase 1 loop) plus its own code chunk, and is asked to report only
// what's genuinely new — real cross-referencing instead of blind trust that an earlier,
// unseen call already covered something. Continuation pieces also run on gpt-4o-mini rather
// than gpt-4o: it's a lighter "does this add anything new" task, and GitHub Models
// rate-limits per model (see the "UserByModelByMinuteTokens" error format), so splitting the
// load across two models also spreads consumption across two separate quotas.
const MAX_INPUT_TOKENS_GH  = 7800  // 8000 minus a small safety margin
const MAX_OUTPUT_TOKENS_GH = 3800  // 4000 minus a small safety margin
// Char threshold (at ~3.5 chars/token) that decides whether an object's code alone still
// fits the input budget after accounting for OBJECT_DOC_PROMPT (~500 tokens) and the
// per-object message overhead (manifest listing, labels — a few hundred tokens, more for
// files with many objects). Conservative relative to the ~24,500-char theoretical ceiling
// so files with a large manifest still have headroom.
const CHUNK_GITHUB = 20000

// Slices oversized code into pieces that each end at a complete statement boundary (right
// after a `;` that isn't inside a string/comment) instead of an arbitrary character cut, so
// no piece ever hands the model a fragment cut off mid-identifier, mid-string, or mid-
// expression. Greedily packs statements into each piece up to maxLen; if a single statement
// itself exceeds maxLen (rare), that one statement is cut at maxLen as a last resort.
export function sliceAtStatementBoundary(code, maxLen) {
  const masked = maskNonCode(code)
  const boundaries = []
  const semiRe = /;/g
  let m
  while ((m = semiRe.exec(masked)) !== null) boundaries.push(m.index + 1)
  if (boundaries.length === 0 || boundaries[boundaries.length - 1] !== code.length) boundaries.push(code.length)

  const pieces = []
  let pieceStart = 0
  let lastBoundary = 0
  for (const b of boundaries) {
    if (b - pieceStart > maxLen) {
      if (lastBoundary > pieceStart) {
        pieces.push(code.slice(pieceStart, lastBoundary))
        pieceStart = lastBoundary
      } else {
        pieces.push(code.slice(pieceStart, pieceStart + maxLen))
        pieceStart += maxLen
      }
    }
    lastBoundary = b
  }
  if (pieceStart < code.length) pieces.push(code.slice(pieceStart))
  return pieces.filter(p => p.length > 0)
}

// Blank out string literals and comments (keeping length/offsets intact) so object
// detection never anchors on a CREATE PROCEDURE mentioned inside a comment or a
// dynamic-SQL string literal — including Oracle's alternative q-quote syntax
// (q'[...]', q'{...}', q'<...>', q'(...)', or q'X...X' for any other delimiter X),
// which the classic '...' pattern alone doesn't recognize as a string boundary.
export function maskNonCode(code) {
  return code.replace(
    /[qQ]'(?:\[[\s\S]*?\]|\{[\s\S]*?\}|<[\s\S]*?>|\([\s\S]*?\)|([^\s'])[\s\S]*?\1)'|'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g,
    m => ' '.repeat(m.length)
  )
}

const OBJECT_HEADER_RE = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE(?:\s+BODY)?|TRIGGER|TYPE)\b/gi

// Detects each PROCEDURE/FUNCTION declared directly inside a PACKAGE BODY (siblings, not
// locally-nested helpers) via a lightweight block-depth scan, so a package with N members
// becomes N individual AI calls instead of one call for the whole body. Returns null if the
// body can't be reliably balanced (unbalanced BEGIN/END, malformed code, etc.) — callers must
// then fall back to sending the whole PACKAGE BODY as a single object, which is always safe.
export function splitPackageBodyMembers(bodyCode) {
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
export function splitByObject(code) {
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
export function extractManifest(code) {
  return splitByObject(code)
    .map(piece => {
      const m = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION|PACKAGE(?:\s+BODY)?|TRIGGER|TYPE)\s+(\w+)/i.exec(maskNonCode(piece))
      return m ? { type: m[1].replace(/\s+/g, ' ').toUpperCase(), name: m[2] } : null
    })
    .filter(Boolean)
}

// Build the per-object documentation request message
export function buildUserMessage(fileName, objCode, objIndex, totalObjects, fullManifest, pieceLabel = '') {
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

// Build the message for ONE extraction piece of an object sliced for GitHub Models' budget
// — used for every piece, including the first. Sends the running `digest` of everything
// already found in earlier pieces of the SAME object as real context — the model can read
// exactly what's already been observed and compare against it, instead of only being told
// (via OBJECT_DOC_EXTRACT_PROMPT) to trust that something was already covered elsewhere.
export function buildExtractMessage(fileName, objCode, digest, pieceLabel) {
  const lines = [`**Archivo:** \`${fileName || 'codigo.sql'}\``, '']
  lines.push(`## Observaciones ya recopiladas de este objeto${pieceLabel}`, '')
  lines.push(digest || '_(Aún no se ha recopilado nada — este es el primer fragmento de este objeto.)_')
  lines.push('', `> ⚠️ **Fragmento de un objeto más grande, no un objeto nuevo:** lo de arriba es TODO lo ya recopilado de este objeto. No lo repitas. El código de abajo puede no empezar o terminar en un límite lógico (p. ej. a mitad de un bloque IF o LOOP).`)
  lines.push('', '## Código PL/SQL (fragmento)', '', '```sql', objCode, '```')
  return lines.join('\n')
}

// Build the message for the one-shot synthesis request: takes ALL the raw observations
// collected across every piece of an object (never a pre-written draft — nothing writes the
// final document until this single call) and asks for the actual, fully structured
// documentation to be written from them.
export function buildSynthesizeMessage(fileName, notes) {
  const lines = [`**Archivo:** \`${fileName || 'codigo.sql'}\``, '']
  lines.push('## Observaciones recopiladas de todos los fragmentos de este objeto', '', notes)
  return lines.join('\n')
}

// Corporate proxy/WAF block pages are mostly <style>/<script>/markup boilerplate with the
// actually identifying text (which security product, what it blocked) buried after all of
// that. Strip tags/scripts/styles down to the readable title + body text instead, so the
// identifying part survives even a short limit.
export function extractReadableText(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() || ''
  const bodyText = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return title && !bodyText.startsWith(title) ? `${title} — ${bodyText}` : bodyText
}

// A non-ok provider response is usually a clean JSON error body — but on a restrictive
// network, a 403/blocked request can instead come back from something in front of it (a
// corporate proxy's own denial page, a WAF), typically as HTML, plain text, or with an
// announced Content-Length but no actual bytes delivered. Reading only .json() (and
// swallowing failures) would hide exactly the detail needed to tell "the provider rejected
// the key" apart from "something on the network blocked this before it ever reached the
// provider" — so this always reads the raw text first and degrades gracefully.
export async function extractErrorMessage(resp) {
  let rawText = '', readErrorMessage = null
  try { rawText = await resp.text() } catch (readErr) { readErrorMessage = readErr?.message || String(readErr) }

  try {
    const j = JSON.parse(rawText)
    return j?.error?.message || `HTTP ${resp.status}`
  } catch {
    const isHtml = /<html[\s>]|<!doctype html/i.test(rawText)
    const readable = isHtml ? extractReadableText(rawText) : rawText
    if (readable) return readable.slice(0, 1000)

    // Nothing readable — surface whatever headers/read-error we do have as a diagnostic
    // trail instead of a bare, unhelpful "empty response".
    const contentLength = resp.headers.get('content-length')
    const contentType   = resp.headers.get('content-type')
    const via           = resp.headers.get('via') || resp.headers.get('x-cache')
    return [
      `HTTP ${resp.status}`,
      readErrorMessage ? `no se pudo leer el cuerpo (${readErrorMessage})` : 'cuerpo vacío',
      contentLength != null ? `content-length: ${contentLength}` : null,
      contentType ? `content-type: ${contentType}` : null,
      via ? `via/x-cache: ${via}` : null,
    ].filter(Boolean).join(', ')
  }
}

// Build the final index/summary request message
export function buildIndexMessage(fileName, fullCode, manifest, isAnthropic) {
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
    const isAnthropicKey = apiKey.startsWith('sk-ant-')
    const isGitHub       = apiKey.startsWith('ghp_') || apiKey.startsWith('github_pat_')
    if (!isAnthropicKey && !isGitHub) { setApiKeyValid(false); return }
    try {
      const r = isAnthropicKey
        ? await fetch(ANTHROPIC_API, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'anthropic-dangerous-direct-browser-access': 'true',
            },
            body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
          })
        : await fetch(GITHUB_MODELS_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: 'openai/gpt-4o-mini', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
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

    // Streams one SSE response and returns its fully assembled text. Buffers any incomplete
    // trailing line across read() calls (a `data: {...}` JSON payload can be split across two
    // network reads) so a chunk boundary can never silently drop or corrupt part of the
    // response. Anthropic and GitHub Models use different SSE event shapes — Anthropic's
    // native `content_block_delta` events vs. GitHub's OpenAI-style `choices[0].delta` —
    // now parsed directly here since there's no server-side proxy to normalize them first.
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
            const delta = isAnthropic
              ? (j.type === 'content_block_delta' ? j.delta?.text : undefined)
              : j.choices?.[0]?.delta?.content
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

    // Build and send one request directly to the provider (no backend/proxy — see
    // ANTHROPIC_API/GITHUB_MODELS_API). `modelOverride` lets continuation pieces run on a
    // lighter model (gpt-4o-mini) instead of the default — see the CHUNK_GITHUB comment.
    const callProxy = async (systemContent, userContent, maxOut, modelOverride) => {
      const estimatedInput  = Math.ceil((systemContent.length + userContent.length) / 3.5)
      // Input and output are separate budgets on GitHub Models — output is simply capped at
      // its own ceiling, never borrowed from whatever's left of the input budget.
      const maxOutputTokens = isAnthropic ? maxOut : Math.min(maxOut, MAX_OUTPUT_TOKENS_GH)

      if (!isAnthropic && estimatedInput >= MAX_INPUT_TOKENS_GH) {
        throw new Error(`Objeto demasiado grande para GitHub Models (${estimatedInput} tokens de entrada est., limite ${MAX_INPUT_TOKENS_GH}). Usa una key de Anthropic para archivos de este tamano.`)
      }

      if (isAnthropic) {
        // Anthropic's own CORS support requires this exact opt-in header for direct
        // browser calls — see docs.anthropic.com / the anthropic-dangerous-direct-
        // browser-access header. System prompt is a top-level field, not a message.
        return fetch(ANTHROPIC_API, {
          method: 'POST',
          signal: abortRef.current.signal,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({
            model: modelOverride || 'claude-sonnet-4-6',
            max_tokens: maxOutputTokens,
            stream: true,
            system: systemContent,
            messages: [{ role: 'user', content: userContent }],
          }),
        })
      }

      return fetch(GITHUB_MODELS_API, {
        method: 'POST',
        signal: abortRef.current.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: modelOverride || 'openai/gpt-4o',
          max_tokens: maxOutputTokens,
          stream: true,
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user',   content: userContent   },
          ],
        }),
      })
    }

    // Waits `ms` milliseconds, but resolves early (rejecting with an AbortError) if the
    // user hits Detener mid-wait — otherwise Stop would appear to do nothing until the
    // full rate-limit backoff finished.
    const waitMs = (ms) => new Promise((resolve, reject) => {
      const signal = abortRef.current?.signal
      if (!signal) { setTimeout(resolve, ms); return }
      if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
    })

    // Sends a request and, if the provider replies with a rate-limit or transient server
    // error, waits and retries automatically instead of aborting the whole multi-object
    // run — a package with many members can legitimately burn through a per-minute token
    // quota partway through, and a momentary 5xx blip shouldn't cost the rest of the batch
    // either. Any other error (e.g. object too large for the provider's budget) is not
    // retried since waiting wouldn't help.
    const RATE_LIMIT_MAX_ATTEMPTS = 3
    const requestWithRetry = async (systemContent, userContent, maxOut, modelOverride) => {
      for (let attempt = 1; attempt <= RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
        const resp = await callProxy(systemContent, userContent, maxOut, modelOverride)
        if (resp.ok) return resp
        const message = await extractErrorMessage(resp)
        // Status code is the primary signal; the message pattern is a narrow secondary
        // check (requires "exceeded"/"wait" near "rate limit") so an unrelated error that
        // merely mentions those words in passing doesn't trigger a pointless retry.
        const isRateLimit  = resp.status === 429 || /rate.?limit.{0,40}(exceed|wait)/i.test(message)
        const isServerBusy = resp.status >= 500 && resp.status < 600
        if ((!isRateLimit && !isServerBusy) || attempt === RATE_LIMIT_MAX_ATTEMPTS) throw new Error(message)
        const waitSec = isRateLimit ? (parseInt(/(\d+)\s*seconds?/i.exec(message)?.[1], 10) || 60) : 4
        setErrorMsg(`⏳ ${message} — reintentando automáticamente (intento ${attempt}/${RATE_LIMIT_MAX_ATTEMPTS})`)
        await waitMs(waitSec * 1000)
        setErrorMsg('')
      }
    }

    let failedCount = 0

    try {
      // ── Phase 1: one isolated request per PL/SQL object ──────────────────
      // Each object's request/stream is its own try/catch: an object that fails for a
      // reason OTHER than the user hitting Detener (network blip, provider error the
      // retry gave up on, object too large for the budget, etc.) gets an error note in
      // its own section instead of discarding every object documented so far AND every
      // object still queued after it — the whole point of sending objects individually
      // is that one bad object shouldn't cost the rest of the file.
      for (let oi = 0; oi < objects.length; oi++) {
        const objCode = objects[oi]

        // A single oversized object (e.g. a very large PACKAGE BODY) is split
        // into pieces only as a last resort for GitHub Models' token budget.
        const pieces = (!isAnthropic && objCode.length > CHUNK_GITHUB)
          ? sliceAtStatementBoundary(objCode, CHUNK_GITHUB)
          : [objCode]

        if (pieces.length === 1) {
          // Common case, not sliced: one request, full documentation structure, as always.
          setMarkdown(renderMarkdown(''))
          const userContent = buildUserMessage(fileName, pieces[0], oi, objects.length, fullManifest)
          try {
            const resp = await requestWithRetry(objSysPrompt, userContent, 8192)
            setPhase('streaming')
            const text = await streamResp(resp, partial => setMarkdown(renderMarkdown(partial)))
            sections.push(stripOuterFence(text))
          } catch (err) {
            if (err.name === 'AbortError') throw err
            failedCount++
            const detected = extractManifest(pieces[0])
            const label = detected.length > 0 ? detected.map(o => `${o.type} \`${o.name}\``).join(', ') : `objeto ${oi + 1} de ${objects.length}`
            sections.push(`## ⚠️ Error al documentar ${label}\n\nEste objeto no pudo documentarse: ${err.message}\n\nEl resto del archivo se documentó normalmente.`)
          }
          setMarkdown(renderMarkdown())
        } else {
          // Sliced object: every piece only extracts raw observations into a running digest
          // — no piece writes the final document, so the eventual write-up is informed by
          // the WHOLE object, not just whatever happened to be in the first chunk. The first
          // piece runs on the full model rather than gpt-4o-mini: it's the one piece that
          // (almost always) contains the CREATE header and full parameter list, so a missed
          // or hallucinated signature there is the costliest possible extraction error —
          // worth the extra accuracy margin. Later pieces are lower-stakes (they only ever
          // ADD supplementary findings on top of an already-correct signature) and run on
          // gpt-4o-mini for speed/cost and to spread load across GitHub Models' per-model
          // rate-limit quotas.
          let digest = ''
          const DIGEST_CAP = 6000

          for (let pi = 0; pi < pieces.length; pi++) {
            setMarkdown(renderMarkdown(''))
            const pieceLabel  = ` — parte ${pi + 1} de ${pieces.length}`
            const userContent = buildExtractMessage(fileName, pieces[pi], digest, pieceLabel)
            const pieceModel  = !isAnthropic ? (pi === 0 ? 'openai/gpt-4o' : 'openai/gpt-4o-mini') : undefined
            try {
              const resp = await requestWithRetry(OBJECT_DOC_EXTRACT_PROMPT, userContent, 2048, pieceModel)
              setPhase('streaming')
              const text = await streamResp(resp, partial => setMarkdown(renderMarkdown(partial)))
              const clean = stripOuterFence(text)
              // Piece 0 is always kept even if it claims "nothing relevant" — it's the only
              // piece guaranteed to have the CREATE header in front of it, so discarding it
              // would leave the digest with zero information about the object's own identity.
              if (pi === 0 || !/Sin información adicional relevante/i.test(clean)) {
                digest += (digest ? '\n\n' : '') + clean.replace(/^###[^\n]*\n+/, '').trim()
                if (digest.length > DIGEST_CAP) digest = digest.slice(-DIGEST_CAP)
              }
            } catch (err) {
              if (err.name === 'AbortError') throw err // user hit Detener — stop everything
              failedCount++
              // One fragment's worth of observations is missed — the remaining pieces (and
              // the final synthesis) can still work with whatever else got collected.
            }
          }

          setMarkdown(renderMarkdown(''))
          if (!digest.trim()) {
            // Every piece failed or found nothing at all to report — nothing to synthesize.
            failedCount++
            sections.push(`## ⚠️ Error al documentar objeto ${oi + 1} de ${objects.length}\n\nNo se pudo recopilar información de ningún fragmento de este objeto.\n\nEl resto del archivo se documentó normalmente.`)
          } else {
            try {
              const synthesizeUser = buildSynthesizeMessage(fileName, digest)
              const resp = await requestWithRetry(OBJECT_DOC_SYNTHESIZE_PROMPT, synthesizeUser, 8192)
              setPhase('streaming')
              const text = await streamResp(resp, partial => setMarkdown(renderMarkdown(partial)))
              sections.push(stripOuterFence(text))
            } catch (err) {
              if (err.name === 'AbortError') throw err
              failedCount++
              // Fall back to the raw collected notes rather than losing them outright —
              // unstructured, but still real information, better than nothing.
              sections.push(`${digest}\n\n_(⚠️ No se pudo generar el formato final pulido de este objeto; estas son las observaciones crudas recopiladas.)_`)
            }
          }
          setMarkdown(renderMarkdown())
        }
      }

      // ── Phase 2: executive index as a separate, focused request ──────────
      // Sending the index as its own request (with the full manifest as context)
      // ensures no object hallucination bleeds in from earlier context.
      setMarkdown(renderMarkdown(''))

      const indexSysPrompt = `Eres un experto documentador PL/SQL Oracle. Genera UNICAMENTE el INDICE GENERAL del wiki en Markdown en espanol. No documentes objetos individuales.

NUNCA envuelvas la respuesta completa en un bloque de codigo (\`\`\`markdown, \`\`\`md o similar). Tu salida ya ES Markdown crudo -- empieza directamente con "# ".

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
      try {
        const indexResp = await requestWithRetry(indexSysPrompt, indexUser, 4096)
        const indexText = await streamResp(indexResp, partial => setMarkdown(renderMarkdown(partial)))
        sections.push(stripOuterFence(indexText))
      } catch (err) {
        if (err.name === 'AbortError') throw err
        failedCount++
        sections.push(`## ⚠️ No se pudo generar el índice general\n\n${err.message}`)
      }
      setMarkdown(renderMarkdown())

      if (failedCount > 0) setErrorMsg(`⚠️ ${failedCount} de ${objects.length + 1} secciones no se pudieron generar — revisa las notas de error dentro del documento.`)
      setPhase('done')
    } catch (err) {
      // Only truly fatal cases land here now: the user hit Detener, or something failed
      // before any per-object try/catch could run (e.g. splitByObject itself throwing).
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
                {phase === 'done' ? '✓ GitHub Wiki Ready' : isRunning ? 'Processing...' : apiKey.startsWith('sk-ant-') ? 'claude-sonnet-4-6' : 'openai/gpt-4o'}
              </span>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
