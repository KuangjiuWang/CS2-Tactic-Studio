import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN/common.json';
import enUS from './locales/en-US/common.json';

export type AppLanguage = 'zh-CN' | 'en-US';
export function normalizeLanguage(language: string | undefined | null): AppLanguage {
  return language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

void i18n.use(initReactI18next).init({
  resources: { 'zh-CN': { common: zhCN }, 'en-US': { common: enUS } },
  lng: normalizeLanguage(typeof navigator === 'undefined' ? 'en-US' : navigator.language),
  fallbackLng: 'en-US', supportedLngs: ['zh-CN', 'en-US'], defaultNS: 'common', ns: ['common'],
  interpolation: { escapeValue: false }, react: { useSuspense: false },
});

export default i18n;
