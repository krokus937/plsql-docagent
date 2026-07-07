// Some models wrap their ENTIRE reply in an outer ```markdown fence despite being told
// not to — the custom renderer then reads that fence as a single opaque code block and
// none of the real headers/tables inside it render. Only strips when the text actually
// opens with a bare ```/```markdown/```md fence line; a legitimate ```sql example block
// used inside a normal response never starts the response, so it's left untouched.
//
// Scans line-by-line (tracking fence depth) rather than anchoring the whole regex to the
// end of the string, so it still finds the wrapper's true closing fence even when the
// response also contains nested ```sql example blocks, or when the model tacks on stray
// commentary after the closing fence despite being told not to wrap at all.
export function stripOuterFence(text) {
  const trimmed = text.trim()
  const lines = trimmed.split('\n')
  if (!/^```(markdown|md)?$/i.test(lines[0].trim())) return text

  let depth = 1
  for (let i = 1; i < lines.length; i++) {
    if (!/^```/.test(lines[i].trim())) continue
    depth += lines[i].trim() === '```' ? -1 : 1
    if (depth === 0) return lines.slice(1, i).join('\n')
  }
  return text // no matching close found — leave untouched rather than guess
}
