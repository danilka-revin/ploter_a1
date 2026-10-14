// Язык чека и кодировка кириллицы: тексты для интерфейса и подсказки.
// Русский чек печатается кириллицей в выбранной кодировке — это требует
// русского шрифта в принтере и совпадающей кодовой страницы (ESC t 17 / 46).
import type { PrinterCharset, PrinterLanguage } from './types';

export interface PrinterLanguageInfo {
  key: PrinterLanguage;
  /** Подпись на кнопке. */
  label: string;
  /** Короткое пояснение рядом с выбором. */
  summary: string;
  /** Подробное описание для подсказки при наведении. */
  hint: string;
}

export const PRINTER_LANGUAGES: PrinterLanguageInfo[] = [
  {
    key: 'en',
    label: 'английский',
    summary: 'латиница и цифры, кириллица транслитом (DEMO A) — работает на любом принтере',
    hint: 'Английский чек: только печатные ASCII-символы, русские подписи печатаются латиницей. '
      + 'Работает на любом чековом принтере — кодировку и русский шрифт проверять не нужно. '
      + 'Режим по умолчанию.',
  },
  {
    key: 'ru',
    label: 'русский',
    summary: 'кириллица как есть — нужен русский шрифт принтера и верная кодировка',
    hint: 'Русский чек: подписи, названия защит и подписи аккумуляторов печатаются кириллицей '
      + 'в выбранной кодировке (cp866, cp1251 или utf8). Требуется, чтобы в шрифте принтера были '
      + 'русские буквы и кодовая страница совпадала: нажмите «Пробная страница» — если вместо букв '
      + 'мусор, смените кодировку (cp866 ↔ cp1251), а если не помогает — верните английский.',
  },
];

export interface PrinterCharsetInfo {
  key: PrinterCharset;
  label: string;
  hint: string;
}

/** Кодировки кириллицы: у cp866 и cp1251 есть номер страницы для ESC t. */
export const PRINTER_CHARSETS: PrinterCharsetInfo[] = [
  { key: 'cp866', label: 'cp866 (DOS)', hint: 'Кодовая страница ESC t 17 — самая частая у дешёвых TTL-модулей 58 мм' },
  { key: 'cp1251', label: 'cp1251 (Windows)', hint: 'Кодовая страница ESC t 46 — Windows-1251, часто у ESC/POS моделей' },
  { key: 'utf8', label: 'utf8', hint: 'UTF-8 без ESC t: подходит принтерам, которые сами разбирают UTF-8' },
];

export const DEFAULT_PRINTER_LANGUAGE: PrinterLanguage = 'en';
export const DEFAULT_PRINTER_CHARSET: PrinterCharset = 'cp866';

/** Незнакомое значение (старый printer.json, чужой запрос) → язык по умолчанию (английский). */
export function printerLanguageKey(value: unknown): PrinterLanguage {
  const key = String(value ?? '').trim().toLowerCase();
  return PRINTER_LANGUAGES.some((l) => l.key === key) ? (key as PrinterLanguage) : DEFAULT_PRINTER_LANGUAGE;
}

export function printerCharsetKey(value: unknown): PrinterCharset {
  const key = String(value ?? '').trim().toLowerCase();
  return PRINTER_CHARSETS.some((c) => c.key === key) ? (key as PrinterCharset) : DEFAULT_PRINTER_CHARSET;
}

export function printerLanguageInfo(value: unknown): PrinterLanguageInfo {
  const key = printerLanguageKey(value);
  return PRINTER_LANGUAGES.find((l) => l.key === key) ?? PRINTER_LANGUAGES[0];
}

/** Русское название языка для журнала и подписей. */
export function printerLanguageLabel(value: unknown): string {
  return printerLanguageInfo(value).label;
}
