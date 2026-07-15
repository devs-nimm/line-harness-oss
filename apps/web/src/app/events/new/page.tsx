'use client'

import Header from '@/components/layout/header'
import EventForm from '@/components/events/event-form'
import { useAccount } from '@/contexts/account-context'
import { useI18n } from '@/lib/i18n'

export default function NewEventPage() {
  const { selectedAccountId } = useAccount()
  const { t } = useI18n()
  if (!selectedAccountId) {
    return (
      <>
        <Header title={t('新規イベント')} />
        <div className="p-4 text-gray-500">{t('アカウントを選択してください。')}</div>
      </>
    )
  }
  return (
    <>
      <Header title={t('新規イベント')} />
      <EventForm accountId={selectedAccountId} eventId={null} />
    </>
  )
}
