'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Header from '@/components/layout/header'
import EventForm from '@/components/events/event-form'
import { useAccount } from '@/contexts/account-context'
import { useI18n } from '@/lib/i18n'

function EditEventInner() {
  const params = useSearchParams()
  const id = params.get('id')
  const { selectedAccountId } = useAccount()
  const { t } = useI18n()
  if (!id) {
    return <div className="p-4 text-red-700">{t('id クエリが必要です')}</div>
  }
  if (!selectedAccountId) {
    return (
      <>
        <Header title={t('イベント編集')} />
        <div className="p-4 text-gray-500">{t('アカウントを選択してください。')}</div>
      </>
    )
  }
  return (
    <>
      <Header title={t('イベント編集')} />
      <EventForm accountId={selectedAccountId} eventId={id} />
    </>
  )
}

export default function EditEventPage() {
  const { t } = useI18n()
  return (
    <Suspense fallback={<div className="p-4 text-gray-500">{t('読み込み中...')}</div>}>
      <EditEventInner />
    </Suspense>
  )
}
