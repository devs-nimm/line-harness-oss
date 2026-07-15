import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '../../../lib/i18n'

// Guards the English support added for /events/new: every Japanese literal the
// page and its EventForm child hand to t() must resolve to a defined English
// string — otherwise English users silently fall back to Japanese (the exact
// bug this addresses). Covers the dynamic t() keys too (tab labels, fed through
// t() from a constant rather than as inline literals).

const here = dirname(fileURLToPath(import.meta.url))
const pageSource = readFileSync(join(here, 'page.tsx'), 'utf8')
const formSource = readFileSync(
  join(here, '../../../components/events/event-form.tsx'),
  'utf8',
)

const JP = /[぀-ヿ一-鿿]/

function tKeys(source: string): string[] {
  // t('...') or t("...")
  const single = [...source.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)].map((m) =>
    m[1].replace(/\\'/g, "'"),
  )
  const double = [...source.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)].map((m) =>
    m[1].replace(/\\"/g, '"'),
  )
  return [...single, ...double]
}

describe('/events/new English coverage', () => {
  it('translates every t(...) literal on the page', () => {
    const keys = tKeys(pageSource).filter((k) => JP.test(k))
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter((k) => !(k in en))).toEqual([])
  })

  it('translates every t(...) literal in EventForm', () => {
    const keys = tKeys(formSource).filter((k) => JP.test(k))
    expect(keys.length).toBeGreaterThan(30) // sanity: strings actually wrapped
    expect(keys.filter((k) => !(k in en))).toEqual([])
  })

  it('translates the dynamic tab labels (label / sub / saveLabel)', () => {
    // TABS is a private const; pull its Japanese label/sub/saveLabel values
    // straight from source since they reach t() dynamically, not as literals.
    const dynamic = [...formSource.matchAll(/(?:label|saveLabel|sub):\s*'([^']*)'/g)]
      .map((m) => m[1])
      .filter((s) => JP.test(s))
    expect(dynamic.length).toBeGreaterThan(0)
    expect(dynamic.filter((k) => !(k in en))).toEqual([])
  })
})
