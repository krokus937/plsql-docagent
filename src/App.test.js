import { describe, it, expect } from 'vitest'
import { splitByObject, extractManifest, maskNonCode, splitPackageBodyMembers, sliceAtStatementBoundary } from './App.jsx'

describe('maskNonCode', () => {
  it('blanks out line comments', () => {
    const masked = maskNonCode('-- comentario CREATE PROCEDURE fantasma\nx := 1;')
    expect(masked).not.toMatch(/CREATE\s+PROCEDURE/i)
    expect(masked.length).toBe('-- comentario CREATE PROCEDURE fantasma\nx := 1;'.length)
  })

  it('blanks out block comments', () => {
    const masked = maskNonCode('/* CREATE PROCEDURE fantasma */\nx := 1;')
    expect(masked).not.toMatch(/CREATE\s+PROCEDURE/i)
  })

  it('blanks out classic string literals, including doubled-quote escapes', () => {
    const masked = maskNonCode("v_x := 'CREATE PROCEDURE fantasma, it''s here';")
    expect(masked).not.toMatch(/CREATE\s+PROCEDURE/i)
  })

  it('blanks out Oracle q-quote literals with bracket delimiters', () => {
    const masked = maskNonCode("q'[texto con 'comillas' y CREATE PROCEDURE fantasma]'")
    expect(masked).not.toMatch(/CREATE\s+PROCEDURE/i)
  })

  it('blanks out Oracle q-quote literals with a generic single-char delimiter', () => {
    const masked = maskNonCode("Q'!CREATE FUNCTION oculto!'")
    expect(masked).not.toMatch(/CREATE\s+FUNCTION/i)
  })

  it('preserves the real code around masked regions untouched', () => {
    const input = "v_x := 'hidden'; SELECT 1 FROM dual;"
    const masked = maskNonCode(input)
    expect(masked).toContain('SELECT 1 FROM dual;')
  })
})

describe('splitByObject + extractManifest — top-level objects', () => {
  const file = [
    'CREATE OR REPLACE TRIGGER trg_x',
    'BEFORE INSERT ON t',
    'BEGIN',
    '  NULL;',
    'END;',
    '/',
    '',
    'CREATE OR REPLACE FUNCTION calcular(p IN NUMBER) RETURN NUMBER IS',
    'BEGIN',
    '  RETURN p;',
    'END calcular;',
    '/',
  ].join('\n')

  it('splits into one piece per top-level object', () => {
    expect(splitByObject(file)).toHaveLength(2)
  })

  it('builds a manifest matching the split', () => {
    const manifest = extractManifest(file)
    expect(manifest).toEqual([
      { type: 'TRIGGER', name: 'trg_x' },
      { type: 'FUNCTION', name: 'calcular' },
    ])
  })

  it('ignores a CREATE PROCEDURE mentioned inside a comment', () => {
    const withComment = '-- ver tambien CREATE PROCEDURE legacy_x\n' + file
    expect(extractManifest(withComment)).toHaveLength(2)
  })

  it('drops leading content before the first CREATE instead of sending it as a fake object', () => {
    const withHeader = '-- Modulo de ventas\n-- =====================\n\n' + file
    expect(splitByObject(withHeader)).toHaveLength(2)
  })

  it('keeps a locally-nested helper embedded in its standalone parent, not split out', () => {
    const withNested = [
      'CREATE OR REPLACE PROCEDURE parent_proc IS',
      '  PROCEDURE helper_interno IS',
      '  BEGIN',
      '    NULL;',
      '  END helper_interno;',
      'BEGIN',
      '  helper_interno();',
      'END parent_proc;',
      '/',
    ].join('\n')
    const manifest = extractManifest(withNested)
    expect(manifest).toEqual([{ type: 'PROCEDURE', name: 'parent_proc' }])
    expect(splitByObject(withNested)[0]).toContain('helper_interno')
  })
})

describe('splitPackageBodyMembers', () => {
  const simplePkgBody = [
    'CREATE OR REPLACE PACKAGE BODY ventas_pkg AS',
    '',
    '  PROCEDURE registrar_venta(p_id IN NUMBER) IS',
    '  BEGIN',
    '    NULL;',
    '  END registrar_venta;',
    '',
    '  PROCEDURE anular_venta(p_id IN NUMBER) IS',
    '  BEGIN',
    '    NULL;',
    '  END anular_venta;',
    '',
    '  FUNCTION calcular_total(p_id IN NUMBER) RETURN NUMBER IS',
    '  BEGIN',
    '    RETURN 0;',
    '  END calcular_total;',
    '',
    'END ventas_pkg;',
    '/',
  ].join('\n')

  it('splits a simple package body into one piece per member', () => {
    const members = splitPackageBodyMembers(simplePkgBody)
    expect(members.map(m => m.name)).toEqual(['registrar_venta', 'anular_venta', 'calcular_total'])
  })

  it('integrates through splitByObject/extractManifest end to end', () => {
    const pkgFile = [
      'CREATE OR REPLACE PACKAGE ventas_pkg AS',
      '  PROCEDURE registrar_venta(p_id IN NUMBER);',
      'END ventas_pkg;',
      '/',
      '',
      simplePkgBody,
    ].join('\n')
    const manifest = extractManifest(pkgFile)
    expect(manifest).toEqual([
      { type: 'PACKAGE', name: 'ventas_pkg' },
      { type: 'PROCEDURE', name: 'registrar_venta' },
      { type: 'PROCEDURE', name: 'anular_venta' },
      { type: 'FUNCTION', name: 'calcular_total' },
    ])
  })

  it('scales to a package with many members (15 procedures + 5 functions)', () => {
    const lines = ['CREATE OR REPLACE PACKAGE BODY grande_pkg AS']
    for (let i = 1; i <= 15; i++) lines.push(`  PROCEDURE proc_${i} IS\n  BEGIN\n    NULL;\n  END proc_${i};\n`)
    for (let i = 1; i <= 5; i++) lines.push(`  FUNCTION func_${i} RETURN NUMBER IS\n  BEGIN\n    RETURN 0;\n  END func_${i};\n`)
    lines.push('END grande_pkg;', '/')
    const members = splitPackageBodyMembers(lines.join('\n'))
    expect(members).toHaveLength(20)
  })

  it('keeps a locally-nested helper embedded in its package member, not split out as a sibling', () => {
    const body = [
      'CREATE OR REPLACE PACKAGE BODY reportes_pkg AS',
      '',
      '  PROCEDURE generar_reporte(p_id IN NUMBER) IS',
      '    PROCEDURE log_interno(p_msg IN VARCHAR2) IS',
      '    BEGIN',
      '      NULL;',
      '    END log_interno;',
      '  BEGIN',
      "    log_interno('inicio');",
      '    NULL;',
      "    log_interno('fin');",
      '  END generar_reporte;',
      '',
      '  PROCEDURE otro_miembro IS',
      '  BEGIN',
      '    NULL;',
      '  END otro_miembro;',
      '',
      'END reportes_pkg;',
      '/',
    ].join('\n')
    const members = splitPackageBodyMembers(body)
    expect(members.map(m => m.name)).toEqual(['generar_reporte', 'otro_miembro'])
    expect(members[0].code).toContain('log_interno')
    expect(members[0].code).toContain('generar_reporte')
  })

  it('does not mis-terminate a member on the bare END of an internal CASE expression', () => {
    const body = [
      'CREATE OR REPLACE PACKAGE BODY clasif_pkg AS',
      '',
      '  FUNCTION clasificar(p_val IN NUMBER) RETURN VARCHAR2 IS',
      '    v_r VARCHAR2(10);',
      '  BEGIN',
      "    v_r := CASE WHEN p_val > 100 THEN 'ALTO' ELSE 'BAJO' END;",
      '    RETURN v_r;',
      '  END clasificar;',
      '',
      '  PROCEDURE siguiente_miembro IS',
      '  BEGIN',
      '    NULL;',
      '  END siguiente_miembro;',
      '',
      'END clasif_pkg;',
      '/',
    ].join('\n')
    const members = splitPackageBodyMembers(body)
    expect(members.map(m => m.name)).toEqual(['clasificar', 'siguiente_miembro'])
  })

  it('falls back to null (safe: caller keeps the whole body as one object) when a member END is malformed', () => {
    const broken = [
      'CREATE OR REPLACE PACKAGE BODY roto_pkg AS',
      '  PROCEDURE miembro_malformado IS',
      '  BEGIN',
      '    NULL;',
      '  -- falta el END aqui a proposito',
      'END roto_pkg;',
      '/',
    ].join('\n')
    expect(splitPackageBodyMembers(broken)).toBeNull()
    // splitByObject must still preserve the whole body intact, not corrupt or drop it
    const pieces = splitByObject(broken)
    expect(pieces).toHaveLength(1)
    expect(pieces[0]).toBe(broken)
  })

  it('works standalone with only the PACKAGE BODY present, no spec in the file', () => {
    const manifest = extractManifest(simplePkgBody)
    expect(manifest.map(o => o.name)).toEqual(['registrar_venta', 'anular_venta', 'calcular_total'])
  })
})

describe('sliceAtStatementBoundary', () => {
  it('never cuts in the middle of a statement — every piece ends with a semicolon (except the last)', () => {
    const body = 'BEGIN\n' + '  v_total := v_total + 1;\n'.repeat(300) + 'END;'
    const pieces = sliceAtStatementBoundary(body, 500)
    expect(pieces.length).toBeGreaterThan(1)
    pieces.slice(0, -1).forEach(p => expect(p.trimEnd().endsWith(';')).toBe(true))
  })

  it('reassembles back to the exact original code with no loss or duplication', () => {
    const body = 'BEGIN\n' + '  v_total := v_total + 1;\n'.repeat(300) + 'END;'
    const pieces = sliceAtStatementBoundary(body, 500)
    expect(pieces.join('')).toBe(body)
  })

  it('never uses a semicolon inside a string literal as a statement boundary', () => {
    const stmt = "v_msg := 'texto con coma falso;aqui dentro sin cerrar aun mas relleno para superar maxlen';"
    const body = 'BEGIN\n  ' + stmt + '\n  v_other := 1;\nEND;'
    const fakeSemiPos = body.indexOf('falso;') + 'falso;'.length // right after the fake ';' inside the string
    const realSemiPos = body.indexOf(stmt) + stmt.length          // right after the statement's real closing ';'
    const maxLen = fakeSemiPos + 5 // just past the fake ';', but still well short of the real one
    expect(maxLen).toBeLessThan(realSemiPos) // sanity check on the fixture itself

    const pieces = sliceAtStatementBoundary(body, maxLen)
    let cumulative = 0
    for (const p of pieces.slice(0, -1)) {
      cumulative += p.length
      expect(cumulative).not.toBe(fakeSemiPos) // the fake ';' must never be chosen as a cut point
    }
    expect(pieces.join('')).toBe(body) // no data lost or duplicated regardless of how it was cut
  })

  it('returns the whole string as one piece when it already fits within maxLen', () => {
    const body = 'BEGIN\n  NULL;\nEND;'
    expect(sliceAtStatementBoundary(body, 5000)).toEqual([body])
  })

  it('falls back to a raw cut for a single statement longer than maxLen (rare edge case)', () => {
    const hugeStatement = 'v_x := ' + "'a'".repeat(50) + ';'
    const pieces = sliceAtStatementBoundary(hugeStatement, 20)
    expect(pieces.join('')).toBe(hugeStatement)
    expect(pieces.length).toBeGreaterThan(1)
  })

  it('produces roughly the expected number of pieces for a large object', () => {
    const body = 'BEGIN\n' + '  v_total := v_total + 1; -- linea de relleno representativa\n'.repeat(2000) + 'END;'
    const pieces = sliceAtStatementBoundary(body, 5000)
    const expectedRoughly = Math.ceil(body.length / 5000)
    expect(pieces.length).toBeGreaterThanOrEqual(expectedRoughly)
    expect(pieces.length).toBeLessThan(expectedRoughly + 3)
  })
})
