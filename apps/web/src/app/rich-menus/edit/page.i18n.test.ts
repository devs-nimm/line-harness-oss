import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '../../../lib/i18n'

// Guards the English support added for /rich-menus/edit: every Japanese
// literal the page hands to t() — including the confirm()/alert()/prompt()
// bodies and the "danger zone" delete/withdraw actions — must resolve to a
// defined English string, otherwise English users silently fall back to
// Japanese.

const here = dirname(fileURLToPath(import.meta.url))
const pageSource = readFileSync(join(here, 'page.tsx'), 'utf8')

const JP = /[぀-ヿ一-鿿]/

function tKeys(source: string): string[] {
  const single = [...source.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) =>
    m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n'),
  )
  const double = [...source.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'),
  )
  return [...single, ...double]
}

describe('/rich-menus/edit English coverage', () => {
  it('translates every t(...) literal on the page', () => {
    const keys = tKeys(pageSource).filter((k) => JP.test(k))
    expect(keys.length).toBeGreaterThan(20)
    expect(keys.filter((k) => !(k in en))).toEqual([])
  })
})
