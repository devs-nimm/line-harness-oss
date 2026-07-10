'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

export default function OpenAIConnectionSetting() {
  const { t } = useI18n()
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [clearApiKey, setClearApiKey] = useState(false)
  const [effectiveBaseUrl, setEffectiveBaseUrl] = useState<string | null>(null)
  const [effectiveModel, setEffectiveModel] = useState<string | null>(null)
  const [hasEffectiveApiKey, setHasEffectiveApiKey] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const loadSettings = useCallback(async () => {
    try {
      const res = await api.accountSettings.getOpenAIConnection()
      if (res.success) {
        setBaseUrl(res.data.baseUrl ?? '')
        setModel(res.data.model ?? '')
        setHasApiKey(Boolean(res.data.hasApiKey))
        setEffectiveBaseUrl(res.data.effectiveBaseUrl ?? null)
        setEffectiveModel(res.data.effectiveModel ?? null)
        setHasEffectiveApiKey(Boolean(res.data.hasEffectiveApiKey))
      }
    } catch {
      // ignore and keep defaults
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        if (!cancelled) await loadSettings()
      } finally {
        if (cancelled) return
      }
    })()
    return () => { cancelled = true }
  }, [loadSettings])

  const handleSave = async () => {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const trimmedBaseUrl = baseUrl.trim()
      const trimmedModel = model.trim()
      const nextApiKey = apiKey.trim()
      const res = await api.accountSettings.updateOpenAIConnection({
        baseUrl: trimmedBaseUrl,
        model: trimmedModel,
        apiKey: clearApiKey ? undefined : nextApiKey || undefined,
        clearApiKey,
      })
      if (!res.success) {
        setError(res.error ?? t('保存に失敗しました'))
        return
      }
      setApiKey('')
      const nextHasApiKey = clearApiKey ? false : (nextApiKey !== '' || hasApiKey)
      setHasApiKey(nextHasApiKey)
      setHasEffectiveApiKey(nextHasApiKey)
      await loadSettings()
      setClearApiKey(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch {
      setError(t('保存に失敗しました'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="text-xs text-gray-400">{t('読み込み中...')}</p>

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
      <h3 className="text-sm font-semibold text-gray-800 mb-1">{t('OpenAI 接続設定（チャット自動返信）')}</h3>
      <p className="text-xs text-gray-500 mb-3">
        {t('未設定時は環境変数 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL を使用します。')}
      </p>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">OPENAI_BASE_URL</label>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">OPENAI_MODEL</label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">OPENAI_API_KEY</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasApiKey ? '•••••••• (saved)' : 'sk-...'}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            autoComplete="new-password"
          />
          <div className="flex items-center gap-2 mt-1">
            <input
              id="clear-openai-api-key"
              type="checkbox"
              checked={clearApiKey}
              onChange={(e) => setClearApiKey(e.target.checked)}
            />
            <label htmlFor="clear-openai-api-key" className="text-xs text-gray-500">
              {t('保存済みの API キーをクリアする')}
            </label>
          </div>
        </div>
      </div>
      <p className="text-xs text-gray-500 mt-2">
        {t('現在有効な設定')}: URL={effectiveBaseUrl ?? '(unset)'} / MODEL={effectiveModel ?? '(unset)'} / API_KEY={hasEffectiveApiKey ? 'set' : 'unset'}
      </p>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      {saved && <p className="text-xs text-green-600 mt-2">{t('保存しました')}</p>}
      <div className="mt-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-xs font-medium disabled:opacity-50"
        >
          {saving ? t('保存中...') : t('保存')}
        </button>
      </div>
    </div>
  )
}
