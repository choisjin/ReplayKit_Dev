import { useCallback } from 'react';
import { useSettings } from '../context/SettingsContext';
import translations, { TranslationKey, Language } from './translations';

/**
 * Simple i18n hook.
 * Usage:
 *   const { t } = useTranslation();
 *   t('common.save')              // => "저장" or "Save"
 *   t('scenario.deleteConfirm', { name: 'foo' })  // => '"foo" 시나리오를 삭제하시겠습니까?'
 */
export function useTranslation() {
  const { settings } = useSettings();
  const lang: Language = settings.language || 'ko';
  const dict = translations[lang] || translations.ko;

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>): string => {
      let text: string = dict[key] ?? translations.ko[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          text = text.replace(`{${k}}`, String(v));
        }
      }
      return text;
    },
    [dict],
  );

  return { t, lang };
}
