'use client'

// Dependency-free i18n for the admin dashboard.
//
// Design: the translation KEY is the existing Japanese literal already in the
// JSX. `t('ダッシュボード')` returns the key unchanged when locale is 'ja'
// (the default), or the English lookup when locale is 'en'. A missing English
// entry falls back to the Japanese key, so partial coverage degrades
// gracefully instead of showing blanks.
//
// To translate a new string: wrap the literal in `t(...)` at the call site and
// add one `'日本語': 'English'` entry to the `en` map below. No key invention,
// no per-page dictionaries.

import { createContext, useContext, useEffect, useState, useCallback } from 'react'

export type Locale = 'ja' | 'en'

const STORAGE_KEY = 'lh_locale'

// English overrides. Key = the Japanese source literal. Anything not listed
// here renders in Japanese.
const en: Record<string, string> = {
  // --- App chrome / shell ---
  管理画面: 'Admin',
  ログアウト: 'Log out',
  メニュー: 'Menu', // used for both the mobile hamburger aria-label and the booking "menus" nav item
  閉じる: 'Close',
  オーナー: 'Owner',
  管理者: 'Admin',
  スタッフ: 'Staff',

  // --- Sidebar section labels ---
  配信: 'Messaging',
  分析: 'Analytics',
  自動化: 'Automation',
  予約: 'Booking',
  設定: 'Settings',

  // --- Sidebar nav items ---
  ダッシュボード: 'Dashboard',
  友だち管理: 'Friends',
  個別チャット: 'Chats',
  友だち追加時設定: 'Friend-add settings',
  シナリオ配信: 'Scenarios',
  一斉配信: 'Broadcasts',
  テンプレート: 'Templates',
  リッチメニュー: 'Rich menus',
  リマインダ: 'Reminders',
  リファラルリンク: 'Referral links',
  アフィリエイト: 'Affiliates',
  CV計測: 'Conversions',
  スコアリング: 'Scoring',
  フォーム回答: 'Form responses',
  重複検出: 'Duplicate detection',
  オートメーション: 'Automations',
  自動返信ルール: 'Auto-reply rules',
  未対応: 'Unanswered',
  予約管理: 'Bookings',
  イベント予約: 'Event booking',
  スタッフ管理: 'Staff',
  LINEアカウント: 'LINE accounts',
  プール管理: 'Pools',
  ユーザー一覧: 'Users',
  BAN検知: 'Ban detection',
  アップデート履歴: 'Update history',
  緊急コントロール: 'Emergency control',

  // --- Language switcher ---
  言語: 'Language',
}

interface I18nValue {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: string) => string
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('ja')

  // Read persisted choice on mount (client-only; SSR renders Japanese default).
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'en' || saved === 'ja') setLocaleState(saved)
  }, [])

  // Keep <html lang> in sync for a11y / correct font shaping.
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    localStorage.setItem(STORAGE_KEY, l)
  }, [])

  const t = useCallback(
    (key: string) => (locale === 'en' ? en[key] ?? key : key),
    [locale],
  )

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
