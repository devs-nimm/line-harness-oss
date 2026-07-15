import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '../../lib/i18n'

// Guards English support on /chats, including the conversation-archive
// feature (MIN-266/267): every Japanese literal the page hands to t() must
// resolve to a defined English string, otherwise English users silently
// fall back to Japanese. Covers archiveReasonLabels too — its values are
// looked up dynamically and passed through t() at the render call site
// rather than as inline t('...') literals, since it's a module-level object
// (a React hook can't be called there).

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'page.tsx'), 'utf8')

const JP = /[぀-ヿ一-鿿]/

function tKeys(src: string): string[] {
  const single = [...src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) =>
    m[1].replace(/\\'/g, "'"),
  )
  const double = [...src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1].replace(/\\"/g, '"'),
  )
  return [...single, ...double]
}

describe('/chats English coverage', () => {
  it('translates every t(...) literal on the page', () => {
    const keys = tKeys(source).filter((k) => JP.test(k))
    expect(keys.length).toBeGreaterThan(20)
    expect(keys.filter((k) => !(k in en))).toEqual([])
  })

  it('translates every archiveReasonLabels value', () => {
    const match = source.match(/const archiveReasonLabels: Record<string, string> = \{([\s\S]*?)\n\}/)
    expect(match).not.toBeNull()
    const values = [...(match?.[1] ?? '').matchAll(/:\s*'([^']*)'/g)].map((m) => m[1])
    expect(values.length).toBeGreaterThan(0)
    expect(values.filter((v) => !(v in en))).toEqual([])
  })
})
