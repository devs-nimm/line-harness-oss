'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

interface TestSendSectionProps {
  broadcastId: string
  accountId: string
  disabled: boolean
}

export default function TestSendSection({ broadcastId, accountId, disabled }: TestSendSectionProps) {
  const { t } = useI18n()
  const [recipients, setRecipients] = useState<Array<{ id: string; displayName: string; pictureUrl: string | null }>>([])
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ sent: number; failed: number; at: string; error?: boolean } | null>(null)
  const [cooldown, setCooldown] = useState(false)

  useEffect(() => {
    api.accountSettings.getTestRecipients(accountId).then(res => {
      if (res.success) setRecipients(res.data)
    })
  }, [accountId])

  const handleTestSend = async () => {
    setSending(true)
    try {
      const res = await api.broadcasts.testSend(broadcastId)
      if (res.success) {
        setResult({
          sent: res.sent ?? 0,
          failed: res.failed ?? 0,
          at: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
        })
        setCooldown(true)
        setTimeout(() => setCooldown(false), 10000)
      }
    } catch {
      setResult({ sent: 0, failed: 0, at: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }), error: true })
    } finally { setSending(false) }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">{t('テスト送信')}</h3>
      {recipients.length === 0 ? (
        <p className="text-xs text-gray-400">
          {t('テスト送信先が未設定です。')}
          <a href="/accounts" className="text-blue-500 hover:underline ml-1">{t('アカウント設定')}</a>
          {t('から設定してください。')}
        </p>
      ) : (
        <>
          <p className="text-xs text-gray-500 mb-2">
            {t('送信先:')} {recipients.map(r => r.displayName).join(', ')} ({recipients.length} {t('名')})
          </p>
          <button
            onClick={handleTestSend}
            disabled={disabled || sending || cooldown}
            className="px-4 py-2 min-h-[44px] text-xs font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
            style={{ backgroundColor: '#3B82F6' }}
          >
            {sending ? t('テスト送信中...') : cooldown ? t('送信済み') : t('テスト送信する')}
          </button>
          {result && (
            <p className={`text-xs mt-2 ${result.error ? 'text-red-600' : 'text-green-600'}`}>
              {result.error
                ? `${result.at} ${t('テスト送信に失敗しました')}`
                : `${result.at} ${t('テスト送信済み')} (${result.sent} ${t('名成功')}${result.failed > 0 ? `, ${result.failed} ${t('名失敗')}` : ''})`}
            </p>
          )}
        </>
      )}
    </div>
  )
}
