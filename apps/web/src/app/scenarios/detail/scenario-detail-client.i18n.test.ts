import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '../../../lib/i18n'

// Guards the English support added for /scenarios/detail (the per-scenario
// step editor): every Japanese literal the page hands to t() must resolve to
// a defined English string, otherwise English users silently fall back to
// Japanese. Covers the dynamic triggerOptions / messageTypeOptions /
// modeBadgeStyle labels, which are defined in module-level arrays/objects
// (t() can't be called there — a React hook) and instead get wrapped with
// t(...) at their JSX render call sites.

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'scenario-detail-client.tsx'), 'utf8')

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

describe('/scenarios/detail English coverage', () => {
  it('translates every t(...) literal in scenario-detail-client.tsx', () => {
    const keys = tKeys(source).filter((k) => JP.test(k))
    expect(keys.length).toBeGreaterThan(20)
    expect(keys.filter((k) => !(k in en))).toEqual([])
  })

  it('translates the module-level trigger/message-type/mode-badge labels', () => {
    const labels = [...source.matchAll(/label:\s*'([^']*)'/g)]
      .map((m) => m[1])
      .filter((s) => JP.test(s))
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.filter((k) => !(k in en))).toEqual([])
  })
})
