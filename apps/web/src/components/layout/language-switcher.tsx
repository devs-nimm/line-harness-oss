'use client'

import { useI18n } from '@/lib/i18n'

// Segmented JA / EN toggle. Lives in the sidebar footer.
export default function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n()

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-400">{t('言語')}</span>
      <div className="inline-flex rounded-md border border-gray-200 overflow-hidden">
        {(['ja', 'en'] as const).map((l) => (
          <button
            key={l}
            onClick={() => setLocale(l)}
            aria-pressed={locale === l}
            className={`px-2 py-1 text-xs font-medium transition-colors ${
              locale === l
                ? 'text-white'
                : 'text-gray-500 hover:bg-gray-100'
            }`}
            style={locale === l ? { backgroundColor: '#06C755' } : {}}
          >
            {l === 'ja' ? '日本語' : 'EN'}
          </button>
        ))}
      </div>
    </div>
  )
}
