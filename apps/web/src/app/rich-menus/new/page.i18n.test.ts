import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '../../../lib/i18n'
import { TEMPLATES } from '../../../lib/rich-menu-templates'

// Guards the English support added for /rich-menus/new: every Japanese literal
// the page hands to t(), plus every template label/description it renders,
// must resolve to a defined English string — otherwise the page silently
// falls back to Japanese for English users (the exact bug this addresses).

const here = dirname(fileURLToPath(import.meta.url))
const pageSource = readFileSync(join(here, 'page.tsx'), 'utf8')

describe('/rich-menus/new English coverage', () => {
  it('has an English entry for every t(...) key used on the page', () => {
    const keys = [...pageSource.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)].map((m) =>
      m[1].replace(/\\'/g, "'"),
    )
    expect(keys.length).toBeGreaterThan(10) // sanity: strings actually wrapped

    const missing = keys.filter((k) => !(k in en))
    expect(missing).toEqual([])
  })

  it('translates every rich-menu template label and description', () => {
    const strings = TEMPLATES.flatMap((tpl) =>
      [tpl.label, tpl.description].filter((s): s is string => Boolean(s)),
    )
    // Japanese-containing strings must have an English override; already-Latin
    // labels (e.g. "2x2", "Compact 3x1") are fine untranslated.
    const missing = strings.filter((s) => /[぀-ヿ一-鿿]/.test(s) && !(s in en))
    expect(missing).toEqual([])
  })
})
