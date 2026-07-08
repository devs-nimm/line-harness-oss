import type { Metadata } from 'next'
import './globals.css'
import AppShell from '@/components/app-shell'
import { I18nProvider } from '@/lib/i18n'

export const metadata: Metadata = {
  title: 'L Harness',
  description: 'L Harness 管理画面',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ja">
      <body className="bg-gray-50 text-gray-900 antialiased" style={{ fontFamily: "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', system-ui, sans-serif" }}>
        <I18nProvider>
          <AppShell>
            {children}
          </AppShell>
        </I18nProvider>
      </body>
    </html>
  )
}
