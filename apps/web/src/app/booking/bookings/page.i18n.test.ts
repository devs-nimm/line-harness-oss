import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '../../../lib/i18n'

// Guards the English support added for /booking/bookings: every Japanese literal
// the page hands to t() must resolve to a defined English string — otherwise
// English users silently fall back to Japanese (the exact bug this addresses).
// Covers the dynamic t() keys too (status tabs, status/action labels fed through
// t() from constant maps rather than as inline literals).

const here = dirname(fileURLToPath(import.meta.url))
const pageSource = readFileSync(join(here, 'page.tsx'), 'utf8')

const JP = /[぀-ヿ一-鿿]/

function tKeys(source: string): string[] {
  const single = [...source.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)].map((m) =>
    m[1].replace(/\\'/g, "'"),
  )
  const double = [...source.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)].map((m) =>
    m[1].replace(/\\"/g, '"'),
  )
  return [...single, ...double]
}

describe('/booking/bookings English coverage', () => {
  it('translates every t(...) literal on the page', () => {
    const keys = tKeys(pageSource).filter((k) => JP.test(k))
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter((k) => !(k in en))).toEqual([])
  })

  it('translates the dynamic tab / status / action labels', () => {
    // STATUS_TABS `label`, and statusLabel / actionLabel map values reach t()
    // dynamically, not as inline literals — pull them straight from source.
    const dynamic = [...pageSource.matchAll(/(?:label|[a-z_]+):\s*'([^']*)'/g)]
      .map((m) => m[1])
      .filter((s) => JP.test(s))
    expect(dynamic.length).toBeGreaterThan(0)
    expect(dynamic.filter((k) => !(k in en))).toEqual([])
  })
})
