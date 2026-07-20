'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import { useI18n } from '@/lib/i18n'
import type { TrafficPool, PoolAccount, LineAccount } from '@line-crm/shared'

export default function PoolsPage() {
  const { t } = useI18n()
  const [pools, setPools] = useState<TrafficPool[]>([])
  const [accounts, setAccounts] = useState<LineAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    const [poolsRes, accRes] = await Promise.all([api.pools.list(), api.lineAccounts.list()])
    if (poolsRes.success) setPools(poolsRes.data)
    else setError(t('プール一覧の取得に失敗しました'))
    if (accRes.success) setAccounts(accRes.data)
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  // Pin main pool to the top
  const sortedPools = [...pools].sort((a, b) =>
    a.slug === 'main' ? -1 : b.slug === 'main' ? 1 : a.name.localeCompare(b.name),
  )

  return (
    <div>
      <Header
        title={t('プール管理')}
        description={t('LINE 公式アカウントの分散先を管理します。アカウントが 1 つでも『メインプール』として表示されます。')}
      />

      <div className="flex justify-between items-center mb-4">
        <span className="text-sm text-gray-500">{pools.length} {t('プール')}</span>
        <button
          onClick={() => setShowCreate(true)}
          className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm hover:bg-blue-700"
        >
          + {t('新規プール')}
        </button>
      </div>

      {error && (
        <div className="p-3 rounded bg-red-50 border border-red-200 text-red-700 text-sm mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          {t('読み込み中...')}
        </div>
      ) : (
        <div className="space-y-3">
          {sortedPools.map((pool) => (
            <PoolCard key={pool.id} pool={pool} accounts={accounts} onChange={load} />
          ))}
        </div>
      )}

      {showCreate && (
        <CreatePoolModal
          accounts={accounts}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false)
            load()
          }}
        />
      )}
    </div>
  )
}

function PoolCard({
  pool,
  accounts,
  onChange,
}: {
  pool: TrafficPool
  accounts: LineAccount[]
  onChange: () => void
}) {
  const { t } = useI18n()
  const isMain = pool.slug === 'main'
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? ''
  const publicUrl = `${apiBase}/pool/${pool.slug}`
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // clipboard requires secure context — silent fallback
    }
  }
  const onDelete = async () => {
    if (isMain) return
    if (!confirm(`${t('プール「')}${pool.name}${t('」を削除しますか?')}`)) return
    const res = await api.pools.delete(pool.id)
    if (res.success) onChange()
    else alert(res.error ?? t('削除に失敗しました'))
  }

  return (
    <div className="bg-white border border-gray-200 rounded p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="font-medium">
            {pool.name}
            {isMain && (
              <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                {t('既定')}
              </span>
            )}
          </h3>
          <p className="text-xs text-gray-500 font-mono">{pool.slug}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onCopy}
            className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-50"
          >
            {copied ? `✓ ${t('コピー済')}` : t('公開 URL コピー')}
          </button>
          {!isMain && (
            <button
              onClick={onDelete}
              className="text-xs px-2 py-1 text-red-600 hover:bg-red-50 rounded"
            >
              {t('削除')}
            </button>
          )}
        </div>
      </div>
      <PoolAccountList poolId={pool.id} accounts={accounts} onChange={onChange} />
    </div>
  )
}

function PoolAccountList({
  poolId,
  accounts,
  onChange,
}: {
  poolId: string
  accounts: LineAccount[]
  onChange: () => void
}) {
  const { t } = useI18n()
  const [members, setMembers] = useState<PoolAccount[]>([])

  const reload = async () => {
    const res = await api.pools.accounts.list(poolId)
    if (res.success) setMembers(res.data)
  }

  useEffect(() => {
    reload()
  }, [poolId])

  const memberAccountIds = new Set(members.map((m) => m.lineAccountId))
  const candidates = accounts.filter((a) => !memberAccountIds.has(a.id))

  const onAdd = async (lineAccountId: string) => {
    const res = await api.pools.accounts.add(poolId, lineAccountId)
    if (res.success) {
      await reload()
      onChange()
    }
  }

  const onRemove = async (poolAccountId: string) => {
    if (!confirm(t('このアカウントをプールから外しますか?'))) return
    const res = await api.pools.accounts.remove(poolId, poolAccountId)
    if (res.success) {
      await reload()
      onChange()
    }
  }

  return (
    <div className="mt-2">
      <ul className="text-sm space-y-1">
        {members.map((m) => {
          const acc = accounts.find((a) => a.id === m.lineAccountId)
          return (
            <li
              key={m.id}
              className="flex items-center justify-between bg-gray-50 px-2 py-1 rounded"
            >
              <span>{acc?.name ?? m.lineAccountId}</span>
              <button
                onClick={() => onRemove(m.id)}
                className="text-xs text-red-600 hover:underline"
              >
                {t('外す')}
              </button>
            </li>
          )
        })}
        {members.length === 0 && (
          <li className="text-xs text-gray-400">{t('所属アカウントなし')}</li>
        )}
      </ul>
      {candidates.length > 0 && (
        <div className="mt-2">
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) {
                onAdd(e.target.value)
                e.target.value = ''
              }
            }}
            className="text-xs border border-gray-200 rounded px-2 py-1"
          >
            <option value="">＋ {t('アカウントを追加')}</option>
            {candidates.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

function CreatePoolModal({
  accounts,
  onClose,
  onCreated,
}: {
  accounts: LineAccount[]
  onClose: () => void
  onCreated: () => void
}) {
  const { t } = useI18n()
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [activeAccountId, setActiveAccountId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const onSubmit = async () => {
    if (!slug || !name || !activeAccountId) return
    setSubmitting(true)
    setError('')
    const res = await api.pools.create({ slug, name, activeAccountId })
    setSubmitting(false)
    if (res.success) onCreated()
    else setError(res.error ?? t('作成に失敗しました'))
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg w-full max-w-md p-6 space-y-3">
        <h2 className="text-lg font-medium">{t('新規プール')}</h2>
        {error && (
          <div className="p-2 rounded bg-red-50 border border-red-200 text-red-700 text-xs">
            {error}
          </div>
        )}
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder={t('slug (例: brand-a)')}
          className="w-full border border-gray-200 rounded px-3 py-2 text-sm font-mono"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('表示名 (例: ブランドA)')}
          className="w-full border border-gray-200 rounded px-3 py-2 text-sm"
        />
        <select
          value={activeAccountId}
          onChange={(e) => setActiveAccountId(e.target.value)}
          className="w-full border border-gray-200 rounded px-3 py-2 text-sm"
        >
          <option value="">{t('最初の所属アカウントを選択')}</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
          <button onClick={onClose} className="text-sm px-3 py-1.5 text-gray-600">
            {t('キャンセル')}
          </button>
          <button
            onClick={onSubmit}
            disabled={submitting || !slug || !name || !activeAccountId}
            className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white disabled:opacity-50"
          >
            {submitting ? t('作成中…') : t('作成')}
          </button>
        </div>
      </div>
    </div>
  )
}
