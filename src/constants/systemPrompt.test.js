import { describe, it, expect } from 'vitest'
import { OBJECT_DOC_PROMPT, OBJECT_DOC_EXTRACT_PROMPT, OBJECT_DOC_SYNTHESIZE_PROMPT } from './systemPrompt.js'

const REQUIRED_SECTIONS = [
  '### 📝 Descripción Detallada',
  '### 📥 Parámetros de Entrada',
  '### 💻 Ejemplos de Uso',
  '### ⚠️ Manejo de Errores y Casos Especiales',
  '### 🗄️ Dependencias y Objetos Relacionados',
  '### 📌 Notas Técnicas Importantes',
]

describe('OBJECT_DOC_PROMPT', () => {
  it('contains every required section header', () => {
    REQUIRED_SECTIONS.forEach(s => expect(OBJECT_DOC_PROMPT).toContain(s))
  })

  it('requires exactly 2 examples', () => {
    expect(OBJECT_DOC_PROMPT).toContain('Ejemplo 1')
    expect(OBJECT_DOC_PROMPT).toContain('Ejemplo 2')
  })
})

// This is the exact bug a user reported: the old "consolidation" prompt (used to merge
// findings from sliced-object continuation pieces into one final section) only vaguely said
// "keep the same structure the draft already has" instead of restating the required
// sections — giving the model room to drop Parámetros/Dependencias/etc. while merging. The
// design changed since: no piece writes a draft anymore, ALL pieces only extract raw
// observations (OBJECT_DOC_EXTRACT_PROMPT below), and OBJECT_DOC_SYNTHESIZE_PROMPT is the
// ONLY request that ever writes the actual document — so it must carry the exact same
// structural contract as OBJECT_DOC_PROMPT, or this regresses silently again.
describe('OBJECT_DOC_SYNTHESIZE_PROMPT', () => {
  it('contains every required section header, same as OBJECT_DOC_PROMPT', () => {
    REQUIRED_SECTIONS.forEach(s => expect(OBJECT_DOC_SYNTHESIZE_PROMPT).toContain(s))
  })

  it('requires exactly 2 examples, same as OBJECT_DOC_PROMPT', () => {
    expect(OBJECT_DOC_SYNTHESIZE_PROMPT).toContain('Ejemplo 1')
    expect(OBJECT_DOC_SYNTHESIZE_PROMPT).toContain('Ejemplo 2')
  })

  it('instructs synthesizing from raw notes, not just echoing them back', () => {
    expect(OBJECT_DOC_SYNTHESIZE_PROMPT).toMatch(/Sintetiza/i)
  })
})

describe('OBJECT_DOC_EXTRACT_PROMPT', () => {
  it('deliberately does NOT carry the full structural template — its job is raw observations, not a full document', () => {
    expect(OBJECT_DOC_EXTRACT_PROMPT).not.toContain('### 📥 Parámetros de Entrada')
    expect(OBJECT_DOC_EXTRACT_PROMPT).toContain('### 📎 Observaciones de este fragmento')
  })

  it('instructs capturing the signature (name/parameters) on the first piece specifically', () => {
    expect(OBJECT_DOC_EXTRACT_PROMPT).toMatch(/primera pieza/i)
    expect(OBJECT_DOC_EXTRACT_PROMPT).toMatch(/firma completa/i)
  })

  it('explicitly forbids writing the final document at this stage', () => {
    expect(OBJECT_DOC_EXTRACT_PROMPT).toMatch(/NO redactes la documentación final/i)
  })
})
