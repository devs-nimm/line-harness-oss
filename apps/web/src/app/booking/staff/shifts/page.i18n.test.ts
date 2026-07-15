import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '../../../../lib/i18n'

// Guards the English support added for /booking/staff/shifts (the weekly
// shift-template + per-shift list editor): every Japanese literal the page
// hands to t() must resolve to a defined English string — otherwise English
// users silently fall back to Japanese.
//
// The day-of-week single-kanji labels (日/月/火/水/木/金/土) are deliberately
// NOT run through t() — they'd collide with unrelated existing dictionary
// keys (e.g. "日" is already used elsewhere as the "days" count-unit suffix)
// — so they're excluded from this scan and translated locally via
// DAY_LABELS_EN instead.

const here = dirname(fileURLToPath(import.meta.url))
const pageSource = readFileSync(join(here, 'page.tsx'), 'utf8')

const JP = /[぀-ヿ一-鿿]/

function tKeys(source: string): string[] {
  const single = [...source.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) =>
    m[1].replace(/\\'/g, "'"),
  )
  const double = [...source.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1].replace(/\\"/g, '"'),
  )
  return [...single, ...double]
}

describe('/booking/staff/shifts English coverage', () => {
  it('translates every t(...) literal on the page', () => {
    const keys = tKeys(pageSource).filter((k) => JP.test(k))
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter((k) => !(k in en))).toEqual([])
  })

  it('gives the day-of-week abbreviations a local English mapping instead of colliding with the shared dictionary', () => {
    expect(pageSource).toContain('DAY_LABELS_EN')
    expect(pageSource).not.toMatch(/t\(d\.label\)/)
  })
})
