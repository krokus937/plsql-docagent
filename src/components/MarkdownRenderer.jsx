// ─── Inline text with bold, italic, code ─────────────────────────────────────
export const InlineText = ({ text }) => {
  if (!text) return null
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`\n]+`|\*[^*]+\*)/g)
  return (
    <span>
      {parts.map((p, i) => {
        if (/^\*\*[^*]+\*\*$/.test(p))
          return <strong key={i} style={{ color: '#e2e8f0', fontWeight: 700 }}>{p.slice(2, -2)}</strong>
        if (/^`[^`]+`$/.test(p))
          return <code key={i} style={{ background: '#0d1a2e', color: '#f6ad55', padding: '1px 5px', borderRadius: 4, fontSize: '0.82em', fontFamily: 'monospace', border: '1px solid #1a2a4a' }}>{p.slice(1, -1)}</code>
        if (/^\*[^*]+\*$/.test(p))
          return <em key={i} style={{ color: '#90cdf4' }}>{p.slice(1, -1)}</em>
        return <span key={i}>{p}</span>
      })}
    </span>
  )
}

// ─── Full Markdown parser + renderer ────────────────────────────────────────
export default function MarkdownRenderer({ text }) {
  if (!text) return null

  const lines = text.split('\n')
  const out = []
  let i = 0
  let codeLines = [], inCode = false, codeLang = ''
  let tableLines = [], inTable = false
  let listItems = [], inList = false, listOrdered = false

  const flushList = () => {
    if (!listItems.length) return
    out.push(
      <ul key={`list-${out.length}`} style={{ margin: '0.4rem 0', padding: 0, listStyle: 'none' }}>
        {listItems.map((item, idx) => (
          <li key={idx} style={{ display: 'flex', gap: '0.5rem', margin: '0.2rem 0', color: '#8aa0b8', fontSize: 'clamp(0.75rem,1.5vw,0.875rem)', alignItems: 'flex-start' }}>
            <span style={{ color: '#4299e1', flexShrink: 0, fontWeight: 700 }}>
              {listOrdered ? `${idx + 1}.` : '▸'}
            </span>
            <span><InlineText text={item} /></span>
          </li>
        ))}
      </ul>
    )
    listItems = []; inList = false
  }

  const flushTable = () => {
    if (tableLines.length < 3) { tableLines = []; inTable = false; return }
    const headers = tableLines[0].split('|').map(h => h.trim()).filter(Boolean)
    const rows = tableLines.slice(2)
      .map(r => r.split('|').map(c => c.trim()).filter(Boolean))
      .filter(r => r.length > 0)
    out.push(
      <div key={`tbl-${out.length}`} style={{ overflowX: 'auto', margin: '0.8rem 0', WebkitOverflowScrolling: 'touch' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'clamp(0.68rem,1.3vw,0.8rem)', minWidth: 280 }}>
          <thead>
            <tr>
              {headers.map((h, hi) => (
                <th key={hi} style={{ padding: '0.45rem 0.7rem', background: '#0a1020', color: '#63b3ed', fontWeight: 700, border: '1px solid #1e3a5a', textAlign: 'left', whiteSpace: 'nowrap' }}>
                  <InlineText text={h} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} style={{ background: ri % 2 === 0 ? 'rgba(10,16,32,0.4)' : 'rgba(26,42,74,0.2)' }}>
                {row.map((cell, ci) => (
                  <td key={ci} style={{ padding: '0.4rem 0.7rem', border: '1px solid #152035', color: '#8fb3cc', verticalAlign: 'top' }}>
                    <InlineText text={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
    tableLines = []; inTable = false
  }

  while (i < lines.length) {
    const line = lines[i]

    // Code block
    if (line.startsWith('```')) {
      if (!inCode) {
        flushList(); if (inTable) flushTable()
        inCode = true; codeLang = line.slice(3).trim() || 'sql'; codeLines = []
      } else {
        out.push(
          <div key={`code-${out.length}`} style={{ margin: '0.8rem 0', borderRadius: 8, overflow: 'hidden', border: '1px solid #1e3a5a' }}>
            <div style={{ background: '#080e1c', padding: '0.4rem 0.8rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #1a2a4a' }}>
              <div style={{ display: 'flex', gap: 4 }}>
                {['#ff5f57','#febc2e','#28c840'].map(c => <div key={c} style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />)}
              </div>
              <span style={{ fontSize: '0.6rem', color: '#3a5a7a', letterSpacing: '1.5px', textTransform: 'uppercase' }}>{codeLang}</span>
            </div>
            <pre style={{ background: '#040810', padding: '0.8rem 1rem', margin: 0, fontSize: 'clamp(0.65rem,1.2vw,0.78rem)', color: '#7ec8e3', lineHeight: 1.6, overflowX: 'auto', fontFamily: 'monospace', WebkitOverflowScrolling: 'touch' }}>
              <code>{codeLines.join('\n')}</code>
            </pre>
          </div>
        )
        inCode = false; codeLines = []
      }
      i++; continue
    }
    if (inCode) { codeLines.push(line); i++; continue }

    // Table
    if (line.match(/^\s*\|/) && line.match(/\|\s*$/)) {
      if (inList) flushList(); inTable = true; tableLines.push(line); i++; continue
    }
    if (inTable && !(line.match(/^\s*\|/) && line.match(/\|\s*$/))) flushTable()

    // Headings
    if (line.startsWith('# ')) {
      flushList()
      out.push(<h1 key={`h1-${out.length}`} style={{ fontFamily: "'Sora',sans-serif", fontSize: 'clamp(1.05rem,2.5vw,1.5rem)', fontWeight: 800, color: '#63b3ed', margin: '1.6rem 0 0.6rem', paddingBottom: '0.5rem', borderBottom: '2px solid #1a2a4a', lineHeight: 1.3 }}><InlineText text={line.slice(2)} /></h1>)
    } else if (line.startsWith('## ')) {
      flushList()
      out.push(<h2 key={`h2-${out.length}`} style={{ fontFamily: "'Sora',sans-serif", fontSize: 'clamp(0.88rem,2vw,1.1rem)', fontWeight: 700, color: '#90cdf4', margin: '1.3rem 0 0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}><span style={{ width: 3, height: 16, background: 'linear-gradient(180deg,#4299e1,#2b6cb0)', borderRadius: 2, display: 'inline-block', flexShrink: 0 }} /><InlineText text={line.slice(3)} /></h2>)
    } else if (line.startsWith('### ')) {
      flushList()
      out.push(<h3 key={`h3-${out.length}`} style={{ fontSize: 'clamp(0.8rem,1.8vw,0.95rem)', fontWeight: 700, color: '#bee3f8', margin: '1rem 0 0.35rem' }}><InlineText text={line.slice(4)} /></h3>)
    } else if (line.startsWith('> ')) {
      flushList()
      out.push(<div key={`bq-${out.length}`} style={{ borderLeft: '3px solid #4299e1', padding: '0.5rem 0.9rem', background: 'rgba(66,153,225,0.07)', margin: '0.6rem 0', borderRadius: '0 8px 8px 0' }}><span style={{ color: '#90cdf4', fontStyle: 'italic', fontSize: 'clamp(0.72rem,1.4vw,0.875rem)' }}><InlineText text={line.slice(2)} /></span></div>)
    } else if (line.match(/^---+$/)) {
      flushList()
      out.push(<hr key={`hr-${out.length}`} style={{ border: 'none', borderTop: '1px solid #1a2a4a', margin: '1.2rem 0' }} />)
    } else if (line.match(/^(\d+)\.\s/)) {
      inList = true; listOrdered = true; listItems.push(line.replace(/^\d+\.\s/, ''))
    } else if (line.match(/^[-*]\s/)) {
      inList = true; listOrdered = false; listItems.push(line.replace(/^[-*]\s/, ''))
    } else if (line.trim() === '') {
      if (inList) flushList()
      out.push(<div key={`sp-${out.length}`} style={{ height: '0.3rem' }} />)
    } else if (line.trim()) {
      if (inList) flushList()
      out.push(<p key={`p-${out.length}`} style={{ margin: '0.15rem 0', color: '#8aa0b8', fontSize: 'clamp(0.72rem,1.4vw,0.875rem)', lineHeight: 1.75 }}><InlineText text={line} /></p>)
    }
    i++
  }
  if (inList) flushList()
  if (inTable) flushTable()

  return <div>{out}</div>
}
