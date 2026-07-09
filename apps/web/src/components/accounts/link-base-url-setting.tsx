'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

/**
 * Global short-link base URL setting.
 *
 * When set, affiliate click-through links use this domain instead of the
 * built-in Worker redirect route.  The operator must configure a Redirect
 * Rule on that domain to forward requests to the Worker's /r/ path.
 *
 * This is a deployment-wide setting — not per-account.
 */
export default function LinkBaseUrlSetting() {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.accountSettings.getLinkBaseUrl()
        if (!cancelled && res.success) {
          setValue(res.data ?? '')
        }
      } catch { /* ignore */ }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const res = await api.accountSettings.updateLinkBaseUrl(value.trim())
      if (res.success) {
        // Normalise stored value: strip trailing slash to match server behaviour.
        setValue(value.trim().replace(/\/$/, ''))
        setSaved(true)
        setTimeout(() => setSaved(false), 3000)
      } else {
        setError(res.error ?? t('保存に失敗しました'))
      }
    } catch {
      setError(t('保存に失敗しました'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <p className="text-xs text-gray-400">{t('読み込み中...')}</p>
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
      <h3 className="text-sm font-semibold text-gray-800 mb-1">{t('短縮リンクドメイン（全アカウント共通）')}</h3>
      <p className="text-xs text-gray-500 mb-3">
        {t('短縮ドメインを使う場合に設定。例:')} <code className="bg-gray-100 px-1 rounded">https://go.example.com</code>
        {t('（そのドメインから Worker の /r/ へ転送する Redirect Rule が必要）')}
      </p>
      <div className="flex gap-2 items-start">
        <div className="flex-1">
          <input
            type="url"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t('https://go.example.com（空欄でデフォルト /r/ を使用）')}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
          {saved && <p className="text-xs text-green-600 mt-1">{t('保存しました')}</p>}
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-xs font-medium disabled:opacity-50 whitespace-nowrap"
        >
          {saving ? t('保存中...') : t('保存')}
        </button>
      </div>
    </div>
  )
}
