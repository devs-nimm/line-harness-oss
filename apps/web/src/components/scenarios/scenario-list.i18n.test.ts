import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '../../lib/i18n'

// Guards English coverage found missing during an i18n audit: this file's
// t(...) literals — including the toggle-active/delete confirm() dialogs —
// must all resolve to a defined English string, otherwise English users
// silently fall back to Japanese.

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'scenario-list.tsx'), 'utf8')

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

describe('scenario-list English coverage', () => {
  it('translates every t(...) literal in the source', () => {
    const keys = tKeys(source).filter((k) => JP.test(k))
    expect(keys.length).toBeGreaterThanOrEqual(5)
    expect(keys.filter((k) => !(k in en))).toEqual([])
  })
})
