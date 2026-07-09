'use client'
import { useUpdateNotification } from '@/hooks/use-update-notification'
import { useI18n } from '@/lib/i18n'

export default function UpdateBanner() {
  const { t } = useI18n()
  const { release, dismiss } = useUpdateNotification()
  if (!release) return null

  return (
    <div className="bg-blue-50 border-b border-blue-200 px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
      <div className="flex items-center gap-2 min-w-0 flex-wrap">
        <span aria-hidden="true">🎉</span>
        <span className="text-blue-900">
          {t('新バージョン')} <strong>{release.tag}</strong> {t('がリリースされました')}
        </span>
        <a
          href={release.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-700 underline hover:text-blue-900"
        >
          {t('詳細を見る')}
        </a>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('このアップデート通知を閉じる')}
        className="shrink-0 text-blue-600 hover:text-blue-800 px-2 -mr-2"
      >
        ✕
      </button>
    </div>
  )
}
