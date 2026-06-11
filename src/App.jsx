import { useState, useRef, useCallback, useEffect } from 'react'
import MarkdownRenderer from './components/MarkdownRenderer.jsx'
import GitHubModal from './components/GitHubModal.jsx'
import { SYSTEM_PROMPT } from './constants/systemPrompt.js'
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

// gpt-4o on GitHub Models: 128K context. System prompt ≈ 5400 tokens.
// Keep chunks at ~20K chars so each call has enough budget for output.
const MAX_CODE_CHARS = 20000

// Subdivide a string into pieces of at most maxLen chars
function sliceAt(str, maxLen) {
  const pieces = []
  for (let i = 0; i < str.length; i += maxLen) pieces.push(str.slice(i, i + maxLen))
  return pieces
}

// Split at logical PL/SQL object boundaries; never cuts inside an object
function splitCode(code) {
  if (code.length <= MAX_CODE_CHARS) return [code]

  const parts = code
    .split(/(?=\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE(?:\s+BODY)?|TRIGGER|TYPE)\b)/i)
    .filter(p => p.trim())

  if (parts.length < 2) return sliceAt(code, MAX_CODE_CHARS)

  // Group parts into chunks ≤ MAX_CODE_CHARS; oversized individual parts get sliced
  const chunks = []
  let current = ''
  for (const part of parts) {
    const safe = part.length <= MAX_CODE_CHARS ? [part] : sliceAt(part, MAX_CODE_CHARS)
    for (const piece of safe) {
      if (current.length + piece.length > MAX_CODE_CHARS && current.length > 0) {
        chunks.push(current)
        current = piece
      } else {
        current += piece
      }
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

// Extract object type + name pairs from PL/SQL code
function extractManifest(code) {
  const re = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION|PACKAGE(?:\s+BODY)?|TRIGGER|TYPE)\s+(\w+)/gi
  const objects = []
  let m
  while ((m = re.exec(code)) !== null) {
    objects.push({ type: m[1].replace(/\s+/g, ' ').toUpperCase(), name: m[2] })
  }
  return objects
}

// Build a structured markdown message so the model has full context about the file
function buildUserMessage(fileName, chunkCode, chunkIndex, totalChunks, fullManifest) {
  const lines = [`**Archivo:** \`${fileName || 'codigo.sql'}\``]

  if (totalChunks > 1 && fullManifest.length > 0) {
    lines.push('', `## Inventario completo del archivo (${fullManifest.length} objetos)`)
    fullManifest.forEach((o, i) => lines.push(`${i + 1}. **${o.type}** → \`${o.name}\``))
  }

  if (totalChunks > 1) {
    const inChunk = extractManifest(chunkCode)
    lines.push('', `## Fragmento ${chunkIndex + 1} de ${totalChunks} — objetos en este bloque`)
    if (inChunk.length > 0) inChunk.forEach(o => lines.push(`- **${o.type}** → \`${o.name}\``))
    else lines.push('_(fragmento sin cabeceras CREATE detectadas)_')
  }

  lines.push('', '## Código PL/SQL', '', '```sql', chunkCode, '```')
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
    if (!apiKey.startsWith('ghp_') && !apiKey.startsWith('github_pat_')) { setApiKeyValid(false); return }
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

    const chunks = splitCode(code)
    const fullManifest = chunks.length > 1 ? extractManifest(code) : []
    let full = '', t = 0

    try {
      for (let ci = 0; ci < chunks.length; ci++) {
        const isLast = ci === chunks.length - 1

        const systemContent = chunks.length > 1 && !isLast
          ? SYSTEM_PROMPT + `\n\n---\n\n**INSTRUCCIÓN (fragmento ${ci + 1} de ${chunks.length}):** Documenta ÚNICAMENTE los objetos de este fragmento con la estructura completa. NO incluyas el ÍNDICE GENERAL ni el Resumen Ejecutivo — esos se generan en el fragmento final.`
          : SYSTEM_PROMPT

        const userContent = buildUserMessage(fileName, chunks[ci], ci, chunks.length, fullManifest)

        // gpt-4o GitHub Models output cap is 16 384; use 8192 as safe practical limit
        const maxOutputTokens = 8192

        const resp = await fetch('/api/proxy', {
          method: 'POST',
          signal: abortRef.current.signal,
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify({
            model: 'gpt-4o',
            max_tokens: maxOutputTokens,
            stream: true,
            messages: [
              { role: 'system', content: systemContent },
              { role: 'user', content: userContent },
            ],
          }),
        })

        if (!resp.ok) {
          const e = await resp.json().catch(() => ({}))
          throw new Error(e?.error?.message || `HTTP ${resp.status}`)
        }

        setPhase('streaming')
        const reader = resp.body.getReader()
        const dec = new TextDecoder()

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          for (const line of dec.decode(value, { stream: true }).split('\n')) {
            if (!line.startsWith('data: ')) continue
            const d = line.slice(6).trim()
            if (d === '[DONE]') continue
            try {
              const j = JSON.parse(d)
              const delta = j.choices?.[0]?.delta?.content
              if (delta) {
                full += delta; t++
                setMarkdown(full); setTokenCount(t * 4)
                if (previewRef.current) previewRef.current.scrollTop = previewRef.current.scrollHeight
              }
            } catch {}
          }
        }

        if (!isLast) { full += '\n\n---\n\n'; setMarkdown(full) }
      }
      setPhase('done')
    } catch (err) {
      if (err.name !== 'AbortError') { setErrorMsg(`❌ ${err.message}`); setPhase('error') }
      else setPhase(full ? 'done' : 'idle')
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
              <div className="logo-sub">Wiki BY (csvelasquez)</div>
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
              placeholder={isMobile ? 'ghp_...' : 'ghp_... o github_pat_...'}
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
            <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" className="get-key-link">Obtener →</a>
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
                {phase === 'done' ? '✓ GitHub Wiki Ready' : isRunning ? 'Processing...' : 'gpt-4o'}
              </span>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
