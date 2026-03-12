import { useState, useEffect } from 'react'

export default function GitHubModal({ markdown, fileName, onClose }) {
  const [ghToken, setGhToken]     = useState(() => sessionStorage.getItem('gh_token') || '')
  const [repo, setRepo]           = useState(() => sessionStorage.getItem('gh_repo') || '')
  const [branch, setBranch]       = useState(() => sessionStorage.getItem('gh_branch') || 'main')
  const [path, setPath]           = useState(() => sessionStorage.getItem('gh_path') || 'wiki/')
  const [commitMsg, setCommitMsg] = useState(`docs: add PL/SQL documentation for ${fileName || 'module'}`)
  const [status, setStatus]       = useState('idle')   // idle | pushing | success | error
  const [statusMsg, setStatusMsg] = useState('')
  const [tokenVisible, setTokenVisible] = useState(false)

  useEffect(() => {
    if (ghToken) sessionStorage.setItem('gh_token', ghToken)
    if (repo)    sessionStorage.setItem('gh_repo', repo)
    sessionStorage.setItem('gh_branch', branch)
    sessionStorage.setItem('gh_path', path)
  }, [ghToken, repo, branch, path])

  const cleanPath = path.replace(/^\/+|\/+$/g, '')
  const docName   = (fileName || 'documentation').replace(/\.sql$/i, '') + '.md'
  const fullPath  = cleanPath ? `${cleanPath}/${docName}` : docName

  const handlePush = async () => {
    if (!ghToken || !repo) { setStatusMsg('⚠️ Token y repositorio son requeridos'); return }
    const parts = repo.trim().split('/')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      setStatusMsg('⚠️ Formato requerido: propietario/nombre-repo'); return
    }
    setStatus('pushing'); setStatusMsg('')
    const [owner, repoName] = parts
    const headers = {
      'Authorization': `Bearer ${ghToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    const apiUrl = `https://api.github.com/repos/${owner}/${repoName}/contents/${fullPath}`
    try {
      let sha = null
      try {
        const check = await fetch(`${apiUrl}?ref=${branch}`, { headers })
        if (check.ok) sha = (await check.json()).sha
      } catch {}

      const content = btoa(unescape(encodeURIComponent(markdown)))
      const res = await fetch(apiUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ message: commitMsg, content, branch, ...(sha ? { sha } : {}) }),
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.message || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setStatus('success')
      setStatusMsg('✅ Archivo publicado correctamente en el repositorio')
      sessionStorage.setItem('gh_published_url', data.content?.html_url || '')
    } catch (err) {
      setStatus('error')
      setStatusMsg(`❌ ${err.message}`)
    }
  }

  const inp = {
    background: '#040810', border: '1px solid #1a2a4a', borderRadius: 7,
    padding: '0.5rem 0.75rem', fontSize: 'clamp(0.7rem,1.3vw,0.75rem)',
    color: '#7ec8e3', fontFamily: 'inherit', width: '100%', outline: 'none',
  }
  const lbl = {
    fontSize: '0.6rem', color: '#4a6080', letterSpacing: '1px',
    textTransform: 'uppercase', display: 'block', marginBottom: 5,
  }

  return (
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
    >
      <div style={{ background: '#0a1020', border: '1px solid #1a2a4a', borderRadius: 14, width: '100%', maxWidth: 500, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 80px rgba(0,0,0,0.7)', animation: 'fadeIn 0.2s ease' }}>

        {/* Header */}
        <div style={{ padding: '1rem 1.2rem', borderBottom: '1px solid #0e1e32', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0, background: '#0a1020', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <span style={{ fontSize: '1.3rem' }}>🐙</span>
            <div>
              <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 700, fontSize: 'clamp(0.85rem,1.8vw,0.92rem)', color: '#e2e8f0' }}>Guardar en GitHub</div>
              <div style={{ fontSize: '0.58rem', color: '#2a4060' }}>Publica tu wiki directamente en el repositorio</div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a6080', fontSize: '1.1rem', lineHeight: 1, padding: '0.2rem' }}>✕</button>
        </div>

        {/* Form */}
        <div style={{ padding: '1.2rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>

          {/* Token */}
          <div>
            <label style={lbl}>🔑 Personal Access Token (PAT)</label>
            <div style={{ position: 'relative' }}>
              <input
                type={tokenVisible ? 'text' : 'password'}
                value={ghToken}
                onChange={e => setGhToken(e.target.value)}
                placeholder="ghp_xxxxxxxxxxxxxxxx"
                style={inp}
              />
              <button onClick={() => setTokenVisible(v => !v)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#2a4060', fontSize: '0.75rem' }}>
                {tokenVisible ? '🙈' : '👁'}
              </button>
            </div>
            <div style={{ fontSize: '0.58rem', color: '#1a2a4a', marginTop: 4 }}>
              Permisos requeridos:{' '}
              <code style={{ color: '#4299e1', background: '#0a1020', padding: '0 3px', borderRadius: 3 }}>repo</code>
              {' · '}
              <a href="https://github.com/settings/tokens/new?scopes=repo&description=PL/SQL+DocAgent" target="_blank" rel="noreferrer" style={{ color: '#4299e1', textDecoration: 'none' }}>
                Crear token →
              </a>
            </div>
          </div>

          {/* Repo */}
          <div>
            <label style={lbl}>📁 Repositorio (owner/nombre)</label>
            <input value={repo} onChange={e => setRepo(e.target.value)} placeholder="mi-empresa/database-docs" style={inp} />
          </div>

          {/* Branch + Path */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.8fr', gap: '0.7rem' }}>
            <div>
              <label style={lbl}>🌿 Branch</label>
              <input value={branch} onChange={e => setBranch(e.target.value)} placeholder="main" style={inp} />
            </div>
            <div>
              <label style={lbl}>📂 Carpeta destino</label>
              <input value={path} onChange={e => setPath(e.target.value)} placeholder="wiki/plsql/" style={inp} />
            </div>
          </div>

          {/* Commit message */}
          <div>
            <label style={lbl}>💬 Mensaje del commit</label>
            <input value={commitMsg} onChange={e => setCommitMsg(e.target.value)} style={inp} />
          </div>

          {/* Path preview */}
          <div style={{ background: '#050a10', borderRadius: 8, padding: '0.7rem 0.9rem', border: '1px solid #0e1e32' }}>
            <div style={{ fontSize: '0.58rem', color: '#2a4060', marginBottom: 4 }}>📍 Ruta final del archivo:</div>
            <code style={{ fontSize: 'clamp(0.62rem,1.2vw,0.72rem)', color: '#4299e1', wordBreak: 'break-all' }}>
              {repo || 'owner/repo'} / {branch} / {fullPath}
            </code>
          </div>

          {/* Status */}
          {statusMsg && (
            <div style={{ padding: '0.65rem 0.9rem', borderRadius: 8, fontSize: 'clamp(0.65rem,1.2vw,0.72rem)', lineHeight: 1.6, background: status === 'success' ? 'rgba(72,187,120,0.08)' : 'rgba(252,129,129,0.08)', border: `1px solid ${status === 'success' ? 'rgba(72,187,120,0.25)' : 'rgba(252,129,129,0.25)'}`, color: status === 'success' ? '#68d391' : '#fc8181' }}>
              {statusMsg}
              {status === 'success' && (
                <div style={{ marginTop: 6 }}>
                  <a href={`https://github.com/${repo}/blob/${branch}/${fullPath}`} target="_blank" rel="noreferrer" style={{ color: '#4299e1', fontSize: '0.65rem' }}>
                    Ver archivo en GitHub →
                  </a>
                </div>
              )}
            </div>
          )}

          {/* Buttons */}
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button onClick={onClose} style={{ flex: 1, padding: '0.65rem', background: 'transparent', border: '1px solid #1a2a4a', borderRadius: 8, cursor: 'pointer', color: '#4a6080', fontSize: 'clamp(0.7rem,1.3vw,0.75rem)', fontFamily: 'inherit', transition: 'all 0.2s' }}>
              Cancelar
            </button>
            <button
              onClick={handlePush}
              disabled={status === 'pushing' || !ghToken || !repo}
              style={{ flex: 2, padding: '0.65rem', background: status === 'success' ? 'linear-gradient(135deg,#276749,#38a169)' : 'linear-gradient(135deg,#1a4a8a,#4299e1)', border: 'none', borderRadius: 8, cursor: (status === 'pushing' || !ghToken || !repo) ? 'not-allowed' : 'pointer', color: '#fff', fontSize: 'clamp(0.7rem,1.3vw,0.78rem)', fontWeight: 700, fontFamily: 'inherit', opacity: (!ghToken || !repo) ? 0.5 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', transition: 'all 0.2s' }}
            >
              {status === 'pushing'
                ? <><div style={{ width: 12, height: 12, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.9s linear infinite' }} /> Publicando...</>
                : status === 'success' ? '✅ Publicar de nuevo' : '🐙 Publicar en GitHub'
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
