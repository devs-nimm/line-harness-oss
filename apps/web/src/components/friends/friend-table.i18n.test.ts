import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '../../lib/i18n'

// This component previously rendered every string in raw Japanese with no
// i18n import at all — English users saw an untranslated table. Guards that
// every t(...) literal here resolves to a defined English string.

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'friend-table.tsx'), 'utf8')

const JP = /[぀-ヿ一-鿿]/

function tKeys(src: string): string[] {
  const single = [...src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) =>
    m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n'),
  )
  const double = [...src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'),
  )
  return [...single, ...double]
}

describe('friend-table English coverage', () => {
  it('translates every t(...) literal in the source', () => {
    const keys = tKeys(source).filter((k) => JP.test(k))
    expect(keys.length).toBeGreaterThanOrEqual(5)
    expect(keys.filter((k) => !(k in en))).toEqual([])
  })
})
