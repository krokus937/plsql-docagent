import { describe, it, expect } from 'vitest'
import { stripOuterFence } from './markdown.js'

describe('stripOuterFence', () => {
  it('strips a simple ```markdown wrapper around the whole response', () => {
    const input = '```markdown\n## PROCEDURE foo\ntexto\n```'
    expect(stripOuterFence(input)).toBe('## PROCEDURE foo\ntexto')
  })

  it('strips a ```md wrapper too', () => {
    const input = '```md\n## FUNCTION bar\ntexto\n```'
    expect(stripOuterFence(input)).toBe('## FUNCTION bar\ntexto')
  })

  it('strips a bare ``` wrapper (no language tag)', () => {
    const input = '```\n## PROCEDURE foo\ntexto\n```'
    expect(stripOuterFence(input)).toBe('## PROCEDURE foo\ntexto')
  })

  it('finds the true closing fence even with a nested ```sql example block inside', () => {
    const input = '```markdown\n## PROCEDURE foo\n\n```sql\nBEGIN foo; END;\n```\n\nmas texto\n```'
    expect(stripOuterFence(input)).toBe('## PROCEDURE foo\n\n```sql\nBEGIN foo; END;\n```\n\nmas texto')
  })

  it('strips the wrapper and discards trailing chat commentary after the closing fence', () => {
    const input = '```markdown\n## PROCEDURE foo\ntexto\n```\n\n¡Listo! Espero que ayude.'
    expect(stripOuterFence(input)).toBe('## PROCEDURE foo\ntexto')
  })

  it('leaves a normal response (no outer wrapper) untouched, including its ```sql example', () => {
    const input = '## PROCEDURE foo\n\n```sql\nBEGIN foo; END;\n```\n\nmas texto'
    expect(stripOuterFence(input)).toBe(input)
  })

  it('does not treat a response that legitimately starts with ```sql as a wrapper', () => {
    const input = '```sql\nBEGIN foo; END;\n```\n\n## PROCEDURE foo'
    expect(stripOuterFence(input)).toBe(input)
  })

  it('leaves text untouched if no matching closing fence is ever found', () => {
    const input = '```markdown\n## PROCEDURE foo\ntexto sin cerrar'
    expect(stripOuterFence(input)).toBe(input)
  })
})
