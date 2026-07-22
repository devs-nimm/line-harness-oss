'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Header from '@/components/layout/header'
import { bookingApi, type BookingShift, type BookingStaff } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { useI18n } from '@/lib/i18n'

type DayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'
const DAYS: Array<{ key: DayKey; label: string; tone: string }> = [
  { key: 'sun', label: '日', tone: 'text-red-500' },
  { key: 'mon', label: '月', tone: '' },
  { key: 'tue', label: '火', tone: '' },
  { key: 'wed', label: '水', tone: '' },
  { key: 'thu', label: '木', tone: '' },
  { key: 'fri', label: '金', tone: '' },
  { key: 'sat', label: '土', tone: 'text-blue-500' },
]

// Day-of-week single-kanji labels aren't run through t() — 日/月/火/水/木/金/土
// are single characters that collide with unrelated existing dictionary keys
// (e.g. "日" is already used elsewhere as the "days" count-unit suffix), so
// they're translated locally by DayKey instead of by literal.
const DAY_LABELS_EN: Record<DayKey, string> = {
  sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat',
}

const DEFAULT_TEMPLATE: Record<DayKey, { start: string; end: string } | null> = {
  sun: null,
  mon: { start: '10:00', end: '19:00' },
  tue: { start: '10:00', end: '19:00' },
  wed: { start: '10:00', end: '19:00' },
  thu: { start: '10:00', end: '19:00' },
  fri: { start: '10:00', end: '19:00' },
  sat: { start: '10:00', end: '19:00' },
}

export default function StaffShiftsPage() {
  const sp = useSearchParams()
  const id = sp.get('staff_id') ?? ''
  const { selectedAccountId } = useAccount()
  const { t, locale } = useI18n()
  const [staffMember, setStaffMember] = useState<BookingStaff | null>(null)
  const [shifts, setShifts] = useState<BookingShift[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tpl, setTpl] = useState(DEFAULT_TEMPLATE)
  const [weeks, setWeeks] = useState(4)
  // toISOString は UTC なので 00:00〜09:00 JST に開いた場合、初期値が前日になる。
  // JST 基準の YYYY-MM-DD に補正。
  const [fromDate, setFromDate] = useState(
    new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10),
  )
  const [generating, setGenerating] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const load = useCallback(async () => {
    if (!selectedAccountId || !id) return
    setLoading(true)
    setError(null)
    // 前 staff/account の表示が残ったまま fetch 失敗 → stale な staff 名・shift
    // 削除ボタンが現 URL に紐付いて見えてしまうのを防ぐ。
    setShifts([])
    setStaffMember(null)
    try {
      const [r, sList] = await Promise.all([
        bookingApi.getShifts(selectedAccountId, id),
        bookingApi.listStaff(selectedAccountId),
      ])
      setShifts(r.shifts)
      setStaffMember(sList.staff.find((s) => s.id === id) ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [id, selectedAccountId])

  useEffect(() => {
    load()
  }, [load])

  async function generate() {
    if (!selectedAccountId) return
    // staff_id 不在ガード: 古いブックマークや URL 手編集での POST `/staff//shifts/generate`
    // を防ぐ。エラーを表示してユーザーに staff 一覧へ戻るよう促す。
    if (!id) {
      setError(t('staff_id が指定されていません。スタッフ一覧から開き直してください。'))
      return
    }
    setGenerating(true)
    setError(null)
    try {
      const r = await bookingApi.generateShifts(selectedAccountId, id, {
        from_date: fromDate,
        weeks,
        weekly_template: tpl,
      })
      setSavedAt(Date.now())
      console.info(`generated ${r.inserted} shifts`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  async function deleteShift(shiftId: string) {
    if (!selectedAccountId) return
    if (!confirm(t('このシフトを削除しますか？'))) return
    await bookingApi.deleteShift(selectedAccountId, id, shiftId)
    await load()
  }

  return (
    <div>
      <Header
        title={t('シフト管理')}
        description={
          staffMember
            ? `「${staffMember.display_name}」${t('の出勤シフト')}`
            : t('曜日テンプレから一括生成、または個別編集')
        }
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}
      {savedAt && Date.now() - savedAt < 3000 && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-800 text-sm">
          {t('シフトを生成しました')}
        </div>
      )}

      {!selectedAccountId ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center text-sm text-gray-500">
          {t('サイドバーでアカウントを選択してください')}
        </div>
      ) : !id ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center text-sm text-gray-500">
          {t('staff_id が指定されていません。')}
          <a href="/booking/staff" className="ml-1 text-blue-600 underline">
            {t('スタッフ一覧')}
          </a>
          {t('から開き直してください。')}
        </div>
      ) : (
        <div className="grid lg:grid-cols-2 gap-4">
          {/* テンプレ生成 */}
          <section className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
              <h2 className="text-sm font-semibold">{t('曜日テンプレから一括生成')}</h2>
              <p className="text-xs text-gray-500 mt-1">
                {t('既に同じ日のシフトがあれば skip されます')}
              </p>
            </div>
            <div className="p-4 space-y-2">
              {DAYS.map((d) => {
                const cur = tpl[d.key]
                return (
                  <div key={d.key} className="flex items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={cur !== null}
                      onChange={(e) =>
                        setTpl({
                          ...tpl,
                          [d.key]: e.target.checked ? { start: '10:00', end: '19:00' } : null,
                        })
                      }
                      className="w-4 h-4"
                    />
                    <span className={`w-6 font-medium ${d.tone}`}>{locale === 'en' ? DAY_LABELS_EN[d.key] : d.label}</span>
                    {cur ? (
                      <>
                        <input
                          type="time"
                          value={cur.start}
                          onChange={(e) => setTpl({ ...tpl, [d.key]: { ...cur, start: e.target.value } })}
                          className="border border-gray-300 rounded-lg px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-green-500"
                        />
                        <span className="text-gray-400">{t('〜')}</span>
                        <input
                          type="time"
                          value={cur.end}
                          onChange={(e) => setTpl({ ...tpl, [d.key]: { ...cur, end: e.target.value } })}
                          className="border border-gray-300 rounded-lg px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-green-500"
                        />
                      </>
                    ) : (
                      <span className="text-xs text-gray-400">{t('休み')}</span>
                    )}
                  </div>
                )
              })}
              <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-gray-100 mt-3">
                <label className="text-xs text-gray-600 flex items-center gap-2">
                  {t('開始日')}
                  <input
                    type="date"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                    className="border border-gray-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                </label>
                <label className="text-xs text-gray-600 flex items-center gap-2">
                  {t('週数')}
                  <input
                    type="number"
                    value={weeks}
                    onChange={(e) => setWeeks(Number(e.target.value))}
                    className="border border-gray-300 rounded-lg px-2 py-1 text-sm w-16 tabular-nums focus:outline-none focus:ring-2 focus:ring-green-500"
                    min={1}
                    max={52}
                  />
                </label>
                <button
                  onClick={generate}
                  disabled={generating}
                  className="ml-auto px-4 py-1.5 text-sm font-medium text-white rounded-lg disabled:opacity-50"
                  style={{ backgroundColor: '#06C755' }}
                >
                  {generating ? t('生成中…') : t('生成')}
                </button>
              </div>
            </div>
          </section>

          {/* 登録済みシフト */}
          <section className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
              <h2 className="text-sm font-semibold">
                {t('登録済みシフト')} ({shifts.length} {t('日')})
              </h2>
            </div>
            {loading ? (
              <div className="p-12 text-center text-sm text-gray-500">{t('読み込み中…')}</div>
            ) : shifts.length === 0 ? (
              <div className="p-12 text-center text-sm text-gray-500">{t('まだシフトがありません')}</div>
            ) : (
              <div className="max-h-[600px] overflow-y-auto">
                <table className="w-full">
                  <thead className="sticky top-0">
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">{t('日付')}</th>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">{t('開始')}</th>
                      <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">{t('終了')}</th>
                      <th className="px-4 py-2 text-right text-xs font-semibold text-gray-500 uppercase">{t('操作')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {shifts.map((s) => (
                      <tr key={s.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-sm tabular-nums">{s.work_date}</td>
                        <td className="px-4 py-2 text-sm tabular-nums">{s.start_time}</td>
                        <td className="px-4 py-2 text-sm tabular-nums">{s.end_time}</td>
                        <td className="px-4 py-2 text-right">
                          <button
                            onClick={() => deleteShift(s.id)}
                            className="text-xs text-red-600 hover:underline"
                          >
                            {t('削除')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
