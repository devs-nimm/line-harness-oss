import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en } from '../../../lib/i18n'

// Guards the English support added for the /inflow-links create/edit modal:
// every Japanese literal the component hands to t() must resolve to a defined
// English string — otherwise the dialog silently falls back to Japanese for
// English users (the exact bug MIN-274 addresses).

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'edit-route-modal.tsx'), 'utf8')

describe('/inflow-links create/edit modal English coverage', () => {
  it('has an English entry for every t(...) key used in the modal', () => {
    const keys = [...source.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)].map((m) =>
      m[1].replace(/\\'/g, "'"),
    )
    expect(keys.length).toBeGreaterThan(10) // sanity: strings actually wrapped

    const missing = keys.filter((k) => !(k in en))
    expect(missing).toEqual([])
  })
})
