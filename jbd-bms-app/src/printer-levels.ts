// Три вида чека чекового принтера: короткий, средний и полный.
// Тексты для интерфейса и журнала собраны здесь, чтобы список видов чека
// не дублировался в плитке принтера, в хранилище и в подсказках.
import type { ReportLevel } from './types';

export interface ReportLevelInfo {
  key: ReportLevel;
  /** Подпись на кнопке. */
  label: string;
  /** Что попадёт на бумагу — коротко, для подписи рядом с выбором. */
  summary: string;
  /** Подробное описание для подсказки при наведении. */
  hint: string;
}

export const REPORT_LEVELS: ReportLevelInfo[] = [
  {
    key: 'short',
    label: 'короткий',
    summary: 'статус · В/А/Вт · заряд · разброс · крайние банки · защиты',
    hint: 'Короткий чек (~20 строк): статус, напряжение, ток, мощность, заряд, остаток, схема банок, '
      + 'разброс Δ, минимальная и максимальная банка, максимальная температура и активные защиты '
      + '(первые две строкой). Печатается быстрее всех — для быстрой проверки и экономии бумаги.',
  },
  {
    key: 'medium',
    label: 'средний',
    summary: '+ все банки сеткой · температуры · ключи и балансировка',
    hint: 'Средний чек (~45 строк): всё из короткого + число циклов, сетка всех банок с метками '
      + '(минимум, максимум, балансировка), температуры по датчикам, ключи заряда и разряда, '
      + 'балансировка, список активных защит и итоги парка.',
  },
  {
    key: 'full',
    label: 'полный',
    summary: '+ каждая банка строкой · счётчики защит · паспорт платы',
    hint: 'Полный чек (~75 строк и больше на 16S): всё из среднего + каждая банка отдельной строкой '
      + 'с отклонением от среднего, счётчики срабатываний защит (регистр 0xAA), регистр защит, паспорт '
      + 'платы (аппаратная версия, прошивка, серийный номер, дата выпуска) и расширенные итоги парка. '
      + 'Самый долгий по времени печати.',
  },
];

export const DEFAULT_REPORT_LEVEL: ReportLevel = 'medium';

/** Незнакомое значение (старый printer.json, чужой запрос) приводится к «среднему». */
export function reportLevelKey(value: unknown): ReportLevel {
  const key = String(value ?? '').trim().toLowerCase();
  return REPORT_LEVELS.some((l) => l.key === key) ? (key as ReportLevel) : DEFAULT_REPORT_LEVEL;
}

/** Русское название вида чека для журнала и подписей. */
export function reportLevelLabel(value: unknown): string {
  const key = reportLevelKey(value);
  return REPORT_LEVELS.find((l) => l.key === key)?.label ?? key;
}

export function reportLevelInfo(value: unknown): ReportLevelInfo {
  const key = reportLevelKey(value);
  return REPORT_LEVELS.find((l) => l.key === key) ?? REPORT_LEVELS[1];
}
