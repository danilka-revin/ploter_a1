// Сервис управления UART-чековым принтером: конфигурация, подключение,
// форматирование сводки и печать по протоколу AlexGyver/Printer
// (TTL UART, 5–9 В, типично 9600/19200 8N1).
//
// Язык чека выбирается: en — английский (подписи ASCII, кириллица транслитом, работает
// на любом принтере) и ru — русский (кириллица как есть в cp866 / cp1251 / utf8, нужны
// русские буквы в шрифте принтера и подходящая кодовая страница ESC t 17 / ESC t 46).
// Читаемость требует совпадения скорости UART, кодировки и протокола: ASCII сам по себе
// её не гарантирует, а неверная кодовая страница даёт «мусор» из правильных байтов.

import {
  ReceiptPrinter, PRINTER_BAUDS, renderReceiptText, toPrinterText, PRINTER_PROFILES, PRINTER_FRAMINGS,
  STATUS_QUERIES, describeStatusByte, plainReceipt, sanitizeText, encodePrinterText,
  PRINTER_LANGUAGES, PRINTER_CHARSETS, CHARSET_CODEPAGE,
} from './printer.mjs';

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

/** Допустимая ширина строки чека в символах (58 мм — 32, 80 мм — 48). */
const WIDTH_MIN = 24;
const WIDTH_MAX = 48;

/**
 * Три вида чека — одна и та же сводка разной глубины:
 *   short  — только главное: статус, В/А/Вт, заряд, остаток, разброс и крайние банки,
 *            максимальная температура и активные защиты (короткий чек ~20 строк);
 *   medium — main + число циклов, сетка всех банок с метками, температуры по датчикам,
 *            ключи заряда/разряда, балансировка и активные защиты (обычный чек, ~45 строк);
 *   full   — medium + каждая банка отдельной строкой с отклонением от среднего, счётчики
 *            срабатываний защит, паспорт платы и итоги парка (полный чек, ~75 строк).
 */
export const REPORT_LEVELS = ['short', 'medium', 'full'];
/** Вид чека по умолчанию: средний (можно задать BMS_PRINTER_REPORT). */
export const DEFAULT_REPORT_LEVEL = REPORT_LEVELS.includes(process.env.BMS_PRINTER_REPORT || '')
  ? process.env.BMS_PRINTER_REPORT
  : 'medium';

const envBaud = Number(process.env.BMS_PRINTER_BAUD || 9600);
const envWidth = Number(process.env.BMS_PRINTER_WIDTH || 32);
const DEFAULTS = {
  profile: 'plain',
  lineDelayMs: 800,
  path: process.env.BMS_PRINTER_PORT || '',
  baudRate: PRINTER_BAUDS.includes(envBaud) ? envBaud : 9600,
  width: Number.isInteger(envWidth) && envWidth >= WIDTH_MIN && envWidth <= WIDTH_MAX ? envWidth : 32,
  framing: PRINTER_FRAMINGS.includes(process.env.BMS_PRINTER_FRAMING || '') ? process.env.BMS_PRINTER_FRAMING : '8N1',
  reportLevel: DEFAULT_REPORT_LEVEL,
  // язык чека: en — английский (по умолчанию), ru — русский
  language: PRINTER_LANGUAGES.includes(process.env.BMS_PRINTER_LANGUAGE || '') ? process.env.BMS_PRINTER_LANGUAGE : 'en',
  // кодировка кириллицы для русского чека: cp866 (по умолчанию), cp1251, utf8
  charset: PRINTER_CHARSETS.includes(process.env.BMS_PRINTER_CHARSET || '') ? process.env.BMS_PRINTER_CHARSET : 'cp866',
};

/**
 * Вид чека без учёта регистра: 'SHORT' → 'short'. Незнакомое значение
 * (старый printer.json, чужой вызов buildBankReceipt) приводится к среднему.
 */
function levelOf(v, fallback = DEFAULT_REPORT_LEVEL) {
  const key = String(v ?? '').trim().toLowerCase();
  return REPORT_LEVELS.includes(key) ? key : fallback;
}

export class PrinterService {
  /**
   * @param {{log?:(m:string)=>void, isPortBusy?:(path:string)=>boolean}} [opts]
   *   isPortBusy — проверка «порт занят платой (банком)». Если порт принтера
   *   одновременно опрашивается как BMS, в него каждую секунду уходят кадры
   *   dd a5 03 00 ff fd 77 — принтер печатает их как иероглифы и «кракозябры»
   *   вместо чека. Печать на такой порт запрещена (см. _ensure).
   */
  constructor({ log = () => {}, isPortBusy = () => false, configFile = null } = {}) {
    this.log = log;
    this.isPortBusy = isPortBusy;
    this.config = { ...DEFAULTS };
    this.configFile = configFile;
    this.printing = false;
    this._closing = Promise.resolve();
    if (configFile && existsSync(configFile)) {
      try {
        const saved = JSON.parse(readFileSync(configFile, 'utf8'));
        // старый printer.json без вида чека и языка (или с опечаткой) не должен терять весь файл
        if (saved && !REPORT_LEVELS.includes(saved.reportLevel)) delete saved.reportLevel;
        if (saved && !PRINTER_LANGUAGES.includes(saved.language)) delete saved.language;
        if (saved && !PRINTER_CHARSETS.includes(saved.charset)) delete saved.charset;
        this.configure(saved, false);
      } catch (e) { this.log(`Не удалось загрузить настройки принтера: ${e.message}`); }
    }
    this.printer = null;
    this.lastError = '';
    this.lastPrintAt = 0;
  }

  status() {
    return {
      configured: Boolean(this.config.path),
      path: this.config.path || '',
      baudRate: this.config.baudRate,
      framing: this.config.framing,
      width: this.config.width,
      profile: this.config.profile,
      lineDelayMs: this.config.lineDelayMs,
      /** вид чека: short (короткий), medium (средний), full (полный) */
      reportLevel: this.config.reportLevel,
      reportLevels: REPORT_LEVELS,
      /** язык чека: en — английский (ASCII), ru — русский (кириллица) */
      language: this.config.language,
      languages: PRINTER_LANGUAGES,
      /** кодировка кириллицы для русского чека */
      charset: this.config.charset,
      charsets: PRINTER_CHARSETS,
      charsetCodepages: CHARSET_CODEPAGE,
      printing: this.printing,
      // порт отдан принтеру, но на нём висит плата: опрос печатается вместо чека
      busy: this.isPortBusy(this.config.path),
      open: Boolean(this.printer?.isOpen),
      lastError: this.lastError,
      lastPrintAt: this.lastPrintAt,
      bauds: PRINTER_BAUDS,
      framings: PRINTER_FRAMINGS,
    };
  }

  configure(patch = {}, persist = true) {
    if (this.printing) throw svcError(409, 'PRINTER_BUSY', 'Дождитесь окончания печати перед изменением настроек.');
    if (patch.profile !== undefined) {
      if (!PRINTER_PROFILES.includes(patch.profile)) throw svcError(400, 'BAD_PROFILE', 'Неизвестный профиль принтера.');
    }
    if (patch.framing !== undefined) {
      if (!PRINTER_FRAMINGS.includes(patch.framing)) throw svcError(400, 'BAD_FRAMING', 'Неизвестный формат кадра: выберите 8N1, 8E1 или 7E1.');
    }
    if (patch.lineDelayMs !== undefined) {
      const ms = Number(patch.lineDelayMs);
      if (!Number.isInteger(ms) || ms < 0 || ms > 2000) throw svcError(400, 'BAD_DELAY', 'Пауза должна быть от 0 до 2000 мс.');
      this.config.lineDelayMs = ms;
    }
    if (patch.reportLevel !== undefined) {
      const level = String(patch.reportLevel ?? '').trim().toLowerCase();
      if (!REPORT_LEVELS.includes(level)) {
        throw svcError(400, 'BAD_LEVEL',
          `Неизвестный вид чека «${patch.reportLevel}»: короткий (short), средний (medium) или полный (full).`);
      }
      this.config.reportLevel = level;
    }
    if (patch.language !== undefined) {
      const lang = String(patch.language ?? '').trim().toLowerCase();
      if (!PRINTER_LANGUAGES.includes(lang)) {
        throw svcError(400, 'BAD_LANGUAGE',
          `Неизвестный язык чека «${patch.language}»: английский (en) или русский (ru).`);
      }
      // порт не закрываем: кодовая страница отправляется перед каждой печатью (см. init)
      this.config.language = lang;
    }
    if (patch.charset !== undefined) {
      const cs = String(patch.charset ?? '').trim().toLowerCase();
      if (!PRINTER_CHARSETS.includes(cs)) {
        throw svcError(400, 'BAD_CHARSET',
          `Неизвестная кодировка чека «${patch.charset}»: cp866, cp1251 или utf8.`);
      }
      this.config.charset = cs;
    }
    if (patch.profile !== undefined) this.config.profile = patch.profile;
    if (patch.framing !== undefined && patch.framing !== this.config.framing) {
      // формат кадра меняет открытие порта — закрываем старый, откроется заново
      if (this.printer) { this._closing = this.printer.close().catch(() => {}); this.printer = null; }
      this.config.framing = patch.framing;
    }
    if (typeof patch.path === 'string') {
      const next = String(patch.path || '').trim();
      if (this.printer && (next !== this.config.path || !next)) {
        // порт меняется — закрываем старый
        this._closing = this.printer.close().catch(() => {});
        this.printer = null;
      }
      this.config.path = next;
    }
    if (patch.baudRate !== undefined && patch.baudRate !== null) {
      const b = Number(patch.baudRate);
      if (PRINTER_BAUDS.includes(b)) {
        if (b !== this.config.baudRate) {
          if (this.printer) { this._closing = this.printer.close().catch(() => {}); this.printer = null; }
          this.config.baudRate = b;
        }
      }
    }
    if (patch.width !== undefined) {
      const w = Number(patch.width);
      if (Number.isInteger(w) && w >= WIDTH_MIN && w <= WIDTH_MAX) this.config.width = w;
    }
    if (persist) this._persist();
    this.log(`конфигурация: ${this.config.path || '(не выбран)'} @ ${this.config.baudRate} ${this.config.framing}, ширина ${this.config.width}, `
      + `чек ${this.config.reportLevel}, язык ${this.config.language === 'ru' ? `русский (${this.config.charset})` : 'английский (ASCII)'}`);
    return this.status();
  }

  /**
   * Вид чека для очередной печати: параметр запроса важнее настройки принтера.
   * @param {string|null|undefined} requested 'short' | 'medium' | 'full'
   * @returns {'short'|'medium'|'full'}
   */
  _level(requested) {
    const asked = String(requested ?? '').trim().toLowerCase();
    if (!asked) return this.config.reportLevel;
    if (!REPORT_LEVELS.includes(asked)) {
      throw svcError(400, 'BAD_LEVEL',
        `Неизвестный вид чека «${requested}»: выберите короткий (short), средний (medium) или полный (full).`);
    }
    return asked;
  }

  /**
   * Язык чека для очередной печати: параметр запроса важнее настройки принтера.
   * @param {string|null|undefined} requested 'en' | 'ru'
   * @returns {'en'|'ru'}
   */
  _lang(requested) {
    const asked = String(requested ?? '').trim().toLowerCase();
    if (!asked) return this.config.language;
    if (!PRINTER_LANGUAGES.includes(asked)) {
      throw svcError(400, 'BAD_LANGUAGE', `Неизвестный язык чека «${requested}»: английский (en) или русский (ru).`);
    }
    return asked;
  }

  /** Кодировка кириллицы для очередной печати: cp866 / cp1251 / utf8. */
  _charset(requested) {
    const asked = String(requested ?? '').trim().toLowerCase();
    if (!asked) return this.config.charset;
    if (!PRINTER_CHARSETS.includes(asked)) {
      throw svcError(400, 'BAD_CHARSET', `Неизвестная кодировка чека «${requested}»: cp866, cp1251 или utf8.`);
    }
    return asked;
  }

  /**
   * Печать одним видом и на одном языке, не меняя сохранённые настройки:
   * драйверу временно подставляются язык и кодировка, потом возвращаются свои.
   */
  async _printLines(p, lines, language, charset) {
    const prev = { language: p.language, charset: p.charset };
    p.language = language;
    p.charset = charset;
    try { await p.printLines(lines); } finally {
      p.language = prev.language;
      p.charset = prev.charset;
    }
  }

  /** Сохранить настройки на диск (рядом с package.json, файл игнорируется Git). */
  _persist() {
    if (!this.configFile) return;
    writeFileSync(this.configFile + '.tmp', JSON.stringify(this.config, null, 2) + '\n');
    renameSync(this.configFile + '.tmp', this.configFile);
  }

  _ensure() {
    if (!this.config.path) throw svcError(400, 'NO_PRINTER', 'Порт принтера не выбран.');
    if (this.isPortBusy(this.config.path)) {
      throw svcError(409, 'PORT_BUSY',
        `Порт ${this.config.path} занят платой (банком): опрос BMS печатается на принтере и мешает чеку. `
        + 'Отключите этот банк или выберите принтеру другой порт.');
    }
    if (!this.printer || this.printer.path !== this.config.path
      || this.printer.baudRate !== this.config.baudRate || this.printer.framing !== this.config.framing) {
      this.printer = new ReceiptPrinter({
        path: this.config.path,
        baudRate: this.config.baudRate,
        width: this.config.width,
        framing: this.config.framing,
        language: this.config.language,
        charset: this.config.charset,
      });
    }
    // ширина, язык и кодировка могли поменяться после первой печати — порт не переоткрываем
    this.printer.width = this.config.width;
    this.printer.profile = this.config.profile;
    this.printer.lineDelayMs = this.config.lineDelayMs;
    this.printer.language = this.config.language;
    this.printer.charset = this.config.charset;
    return this.printer;
  }

  /**
   * «Мусор вместо текста» на бумаге почти всегда значит, что не совпала
   * скорость UART: принтер читает наши байты как чужие и печатает ерунду,
   * включая цифры и латиницу. Автопоиск перебирает скорости и форматы кадра
   * и спрашивает у принтера состояние (ESC v 0 / GS r / DLE EOT): ответ есть
   * только на «своей» скорости. Бумага почти не расходуется — команды статуса
   * не печатают (на чужой скорости принтер может выдать пару мусорных знаков).
   */
  async detectBaud({ bauds = PRINTER_BAUDS, framings = PRINTER_FRAMINGS, timeoutMs = 150 } = {}) {
    if (this.printing) throw svcError(409, 'PRINTER_BUSY', 'Принтер уже печатает.');
    const p = this._ensure();
    const baudList = (Array.isArray(bauds) ? bauds.filter((b) => PRINTER_BAUDS.includes(b)) : []).length ? bauds : PRINTER_BAUDS;
    const framingList = (Array.isArray(framings) ? framings.filter((f) => PRINTER_FRAMINGS.includes(f)) : []).length ? framings : PRINTER_FRAMINGS;
    const wait = Math.max(10, Number(timeoutMs) || 150);
    this.printing = true;
    const hits = [];
    let tried = 0;
    try {
      await this._closing;
      await p.open();
      for (const framing of framingList) {
        for (const baudRate of baudList) {
          tried++;
          await p.setLine({ baudRate, framing });
          // сначала самый частый запрос: на чужой скорости каждый лишний запрос — мусор на бумаге
          let answer = await p.queryStatus({ queries: [STATUS_QUERIES[0]], timeoutMs: wait });
          if (!answer.bytes.length) answer = await p.queryStatus({ queries: STATUS_QUERIES.slice(1), timeoutMs: Math.max(10, Math.round(wait * 0.8)) });
          if (!answer.bytes.length) continue;
          const confirm = await p.queryStatus({ queries: [STATUS_QUERIES[0]], timeoutMs: wait });
          hits.push({
            baudRate,
            framing,
            byte: answer.bytes[0],
            hex: answer.hex,
            query: answer.query,
            status: describeStatusByte(answer.bytes[0]),
            confirmed: confirm.bytes.length > 0 && confirm.bytes[0] === answer.bytes[0],
          });
          break;   // нашли рабочие настройки — остальные скорости не нужны
        }
        if (hits.length) break;
      }
    } catch (e) {
      this.lastError = e.message;
      throw svcError(502, 'DETECT_FAILED', `Автопоиск скорости: ${e.message}`);
    } finally {
      const best = hits.find((h) => h.confirmed && h.status?.plausible)
        ?? hits.find((h) => h.status?.plausible) ?? hits[0];
      if (best) {
        this.config.baudRate = best.baudRate;
        this.config.framing = best.framing;
        this._persist();
        this.log(`рабочая скорость ${best.baudRate} ${best.framing} (ответ ${best.hex || best.byte}) — сохранена`);
      }
      if (this.printer) {
        this.printer.baudRate = this.config.baudRate;
        this.printer.framing = this.config.framing;
        await this.printer.setLine({ baudRate: this.config.baudRate, framing: this.config.framing }).catch(() => {});
      }
      this.printing = false;
    }
    const best = hits[0] ?? null;
    if (best) this.lastError = '';
    return {
      ok: Boolean(best),
      tried,
      hits,
      baudRate: this.config.baudRate,
      framing: this.config.framing,
      found: Boolean(best),
      message: best
        ? `Принтер ответил на ${best.baudRate} ${best.framing} (${best.hex}). Скорость и формат кадра сохранены — нажмите «Пробная страница».`
        : `Принтер не ответил ни на одной из ${tried} комбинаций скорости и формата кадра. `
          + 'Проверьте: TX принтера → RX адаптера (без этого ответа не будет), общий GND, '
          + 'что модуль именно TTL, а не RS-232 (у RS-232 уровни ±5 В — нужен преобразователь MAX3232/SP3232). '
          + 'Если провод TX не подключён, нажмите «Печатать на всех скоростях» и посмотрите, какой блок на бумаге читается.',
    };
  }

  /**
   * Напечатать короткий блок на каждой скорости: на бумаге находится один
   * читаемый блок — это и есть скорость принтера. Нужен тем, у кого не
   * подключён TX принтера (ответ на запрос статуса не приходит).
   */
  async sweepBauds({ bauds = PRINTER_BAUDS, paceMs = 250 } = {}) {
    if (this.printing) throw svcError(409, 'PRINTER_BUSY', 'Принтер уже печатает.');
    const p = this._ensure();
    const baudList = (Array.isArray(bauds) ? bauds.filter((b) => PRINTER_BAUDS.includes(b)) : []).length ? bauds : PRINTER_BAUDS;
    this.printing = true;
    const before = { baudRate: this.config.baudRate, framing: this.config.framing };
    const prevDelay = p.lineDelayMs;
    const printed = [];
    try {
      await this._closing;
      await p.open();
      // на каждой скорости блок печатается целиком: пауза не даёт буферу принтера переполниться
      p.lineDelayMs = Math.max(0, Number(paceMs) || 0, this.config.lineDelayMs);
      for (const baudRate of baudList) {
        await p.setLine({ baudRate, framing: this.config.framing });
        await p.printLines(baudSweepLines(baudRate, this.config.framing), this.config.width);
        printed.push(baudRate);
      }
    } catch (e) {
      this.lastError = e.message;
      throw svcError(502, 'SWEEP_FAILED', `Перебор скоростей: ${e.message}`);
    } finally {
      p.lineDelayMs = prevDelay;
      await p.setLine(before).catch(() => {});
      this.printing = false;
    }
    return {
      ok: true,
      printed,
      baudRate: before.baudRate,
      framing: before.framing,
      message: `Напечатано ${printed.length} блоков по 2 строки. Найдите блок, который читается, и выберите его скорость в списке «скорость UART», затем нажмите «Пробная страница». `
        + 'Если читаемого блока нет ни на одной скорости — дело не в скорости: проверьте GND, TTL против RS-232 и пайку провода RX принтера.',
    };
  }

  /** Спросить состояние принтера на текущих настройках (бумага, ошибки). */
  async queryPrinter({ timeoutMs = 250 } = {}) {
    if (this.printing) throw svcError(409, 'PRINTER_BUSY', 'Принтер уже печатает.');
    const p = this._ensure();
    this.printing = true;
    try {
      await this._closing;
      await p.open();
      const r = await p.queryStatus({ timeoutMs });
      const st = r.status;
      if (r.bytes.length) this.lastError = '';
      return {
        ok: r.bytes.length > 0,
        at: Date.now(),
        baudRate: this.config.baudRate,
        framing: this.config.framing,
        query: r.query,
        byte: r.bytes.length ? r.bytes[0] : null,
        hex: r.hex,
        paper: st ? (st.paperOut ? 'out' : 'ok') : 'unknown',
        status: st,
        message: r.bytes.length
          ? `Принтер ответил на ${this.config.baudRate} ${this.config.framing}: ${st.text}. Значит, скорость и провод TX принтера в порядке — печатайте чек.`
          : `На ${this.config.baudRate} ${this.config.framing} принтер молчит. Нажмите «Найти скорость» (перебор всех скоростей) `
            + 'или «Печатать на всех скоростях». Ответа не будет и тогда, когда не подключён TX принтера → RX адаптера.',
      };
    } catch (e) {
      this.lastError = e.message;
      throw svcError(502, 'QUERY_FAILED', `Запрос состояния принтера: ${e.message}`);
    } finally { this.printing = false; }
  }

  // Короткий тест транспорта: ни ESC, ни нагрев, ни выбор кодовой страницы.
  async diagnostic() {
    if (this.printing) throw svcError(409, 'PRINTER_BUSY', 'Принтер уже печатает.');
    const p = this._ensure();
    this.printing = true;
    try {
      await this._closing;
      await p.open();
      await p.send(Buffer.from(`\r\nUART ${this.config.baudRate} 8N1\r\n`, 'ascii'));
      await new Promise((resolve) => setTimeout(resolve, this.config.lineDelayMs));
      await p.send(Buffer.from('Hello 123 ABC abc +-*/\r\n\r\n', 'ascii'));
      this.lastError = '';
      this.lastPrintAt = Date.now();
      return {
        ok: true,
        at: this.lastPrintAt,
        language: this.config.language,
        message: this.config.language === 'ru'
          ? `Байты отправлены (латиница читается всегда). Русский чек печатается в ${this.config.charset}: проверьте его пробной страницей — если вместо букв мусор, смените кодировку.`
          : 'Байты отправлены. Подтвердите читаемость на бумаге.',
      };
    } catch (e) {
      this.lastError = e.message;
      throw svcError(502, 'PRINT_FAILED', `Тест UART: ${e.message}`);
    } finally { this.printing = false; }
  }

  async testPage() {
    if (this.printing) throw svcError(409, 'PRINTER_BUSY', 'Принтер уже печатает.');
    const p = this._ensure();
    this.printing = true;
    try {
      await this._closing;
      await p.open();
      await p.printLines(buildTestPage({ path: p.path, baudRate: p.baudRate, width: p.width, language: p.language }));
      this.lastError = '';
      this.lastPrintAt = Date.now();
      return { ok: true, at: this.lastPrintAt, path: p.path, baudRate: p.baudRate };
    } catch (e) {
      this.lastError = e.message;
      throw svcError(502, 'PRINT_FAILED', `Не удалось отправить текст: ${e.message}`);
    } finally { this.printing = false; }
  }

  /**
   * Напечатать сводку по одному банку (BMS).
   * @param {object} bankRow      — строка банка из banks.row()
   * @param {object} fleet        — итоги парка (для сводки "всего в парке")
   * @param {'short'|'medium'|'full'} [level] — вид чека; без него берётся настройка принтера
   * @param {{language?:'en'|'ru', charset?:'cp866'|'cp1251'|'utf8'}} [opts] — язык чека и кодировка
   */
  async printBank(bankRow, fleet = null, level = null, opts = {}) {
    if (this.printing) throw svcError(409, 'PRINTER_BUSY', 'Принтер уже печатает.');
    const lvl = this._level(level);
    const language = this._lang(opts.language);
    const charset = this._charset(opts.charset);
    const p = this._ensure();
    this.printing = true;
    try {
      await this._closing;
      await p.open();
      await this._printLines(p, buildBankReceipt(bankRow, fleet, p.width, lvl, language), language, charset);
      this.lastError = '';
      this.lastPrintAt = Date.now();
      return { ok: true, at: this.lastPrintAt, bank: bankRow.label, path: p.path, level: lvl, language, charset };
    } catch (e) {
      this.lastError = e.message;
      throw svcError(502, 'PRINT_FAILED', `Печать сводки не удалась: ${e.message}`);
    } finally { this.printing = false; }
  }

  /**
   * Напечатать сводку по всем банкам (парку).
   * @param {object[]} rows — строки банков из banks.row()
   * @param {object} fleet  — итоги парка
   * @param {'short'|'medium'|'full'} [level] — вид чека; без него берётся настройка принтера
   * @param {{language?:'en'|'ru', charset?:'cp866'|'cp1251'|'utf8'}} [opts] — язык чека и кодировка
   */
  async printFleet(rows, fleet, level = null, opts = {}) {
    if (this.printing) throw svcError(409, 'PRINTER_BUSY', 'Принтер уже печатает.');
    const lvl = this._level(level);
    const language = this._lang(opts.language);
    const charset = this._charset(opts.charset);
    const p = this._ensure();
    this.printing = true;
    try {
      await this._closing;
      await p.open();
      await this._printLines(p, buildFleetReceipt(rows, fleet, p.width, lvl, language), language, charset);
      this.lastError = '';
      this.lastPrintAt = Date.now();
      return { ok: true, at: this.lastPrintAt, banks: rows.length, path: p.path, level: lvl, language, charset };
    } catch (e) {
      this.lastError = e.message;
      throw svcError(502, 'PRINT_FAILED', `Печать сводки по парку не удалась: ${e.message}`);
    } finally { this.printing = false; }
  }

  // ---------- предпросмотр: тот же чек текстом, без принтера ----------

  /**
   * Предпросмотр обязан совпадать с бумагой, поэтому для русского чека
   * строки не только показываются, но и кодируются в буфер принтера: из него
   * видно, какие байты уйдут в UART и не попал ли в текст «?».
   */
  _render(lines, width, language = this.config.language, charset = this.config.charset) {
    const prepared = this.config.profile === 'plain' ? plainReceipt(lines) : lines;
    const shown = renderReceiptText(prepared, width, { language });
    const bytes = Buffer.concat(
      shown.map((line) => Buffer.concat([encodePrinterText(line, { language, charset }), Buffer.from([0x0d, 0x0a])])),
    );
    return { shown, bytes };
  }

  /**
   * Общее для всех предпросмотров: вид чека, язык, кодировка и байты для UART.
   * `lines` — так чек ляжет на бумагу (тот же текст, что и `text`), `raw` — команды
   * раскладки до рендера, `bytes` — ровно те байты, что уйдут в принтер.
   */
  _preview(kind, level, lines, width, language = this.config.language) {
    const { shown, bytes } = this._render(lines, width, language);
    return {
      kind,
      level,
      width,
      language,
      charset: language === 'ru' ? this.config.charset : null,
      lines: shown,
      text: shown,
      raw: lines,
      bytes,
    };
  }

  previewTest() {
    const width = this.config.width;
    const lines = buildTestPage({
      path: this.config.path || '(not selected)', baudRate: this.config.baudRate, width, language: this.config.language,
    });
    return this._preview('test', null, lines, width);
  }

  previewBank(bankRow, fleet = null, level = null, language = null) {
    const width = this.config.width;
    const lvl = this._level(level);
    const lang = this._lang(language);
    return this._preview('bank', lvl, buildBankReceipt(bankRow, fleet, width, lvl, lang), width, lang);
  }

  previewFleet(rows, fleet, level = null, language = null) {
    const width = this.config.width;
    const lvl = this._level(level);
    const lang = this._lang(language);
    return this._preview('fleet', lvl, buildFleetReceipt(rows, fleet, width, lvl, lang), width, lang);
  }

  async close() {
    await this._closing;
    if (this.printer) await this.printer.close().catch(() => {});
    this.printer = null;
  }
}

// ---------- форматирование чека: английский (ASCII) или русский (cp866/cp1251/utf8) ----------

const pad2 = (v) => String(v).padStart(2, '0');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Форматирование чисел под язык чека: 39.71 V (en) и 39,71 В (ru). */
const FMT_EN = {
  na: 'n/a',
  num: (v, d = 0, unit = '') => (isNum(v) ? `${v.toFixed(d)}${unit ? ` ${unit}` : ''}` : 'n/a'),
  volts: (mv) => (isNum(mv) ? `${(mv / 1000).toFixed(3)} V` : 'n/a'),
  temp: (t) => (isNum(t) && t > -273 ? `${t.toFixed(1)} C` : 'n/a'),
  onOff: (v) => (v === null || v === undefined ? 'n/a' : v ? 'on' : 'OFF'),
  // время «ГГГГ-ММ-ДД ЧЧ:ММ» — однозначно для английского чека
  time: (ts) => {
    if (!ts) return 'n/a';
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  },
  ah: (rem, full, d = 2) => {
    if (!isNum(rem)) return 'n/a';
    return isNum(full) ? `${rem.toFixed(d)} / ${full.toFixed(d)} Ah` : `${rem.toFixed(d)} Ah`;
  },
};

/** Русский чек: запятая в дробях, единицы по-русски, «н/д» вместо «n/a». */
const FMT_RU = {
  na: 'н/д',
  num: (v, d = 0, unit = '') => (isNum(v) ? `${v.toFixed(d).replace('.', ',')}${unit ? ` ${unit}` : ''}` : 'н/д'),
  volts: (mv) => (isNum(mv) ? `${(mv / 1000).toFixed(3).replace('.', ',')} В` : 'н/д'),
  temp: (t) => (isNum(t) && t > -273 ? `${t.toFixed(1).replace('.', ',')} °C` : 'н/д'),
  onOff: (v) => (v === null || v === undefined ? 'н/д' : v ? 'вкл' : 'выкл'),
  // время «ДД.ММ.ГГГГ ЧЧ:ММ» — привычная русская запись
  time: (ts) => {
    if (!ts) return 'н/д';
    const d = new Date(ts);
    return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  },
  ah: (rem, full, d = 2) => {
    if (!isNum(rem)) return 'н/д';
    const f = (v) => v.toFixed(d).replace('.', ',');
    return isNum(full) ? `${f(rem)} / ${f(full)} Ач` : `${f(rem)} Ач`;
  },
};

/** Дата паспорта платы «ДД.ММ.ГГГГ» → «ГГГГ-ММ-ДД» (в русском чеке остаётся как на плате). */
function isoDate(s) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(s ?? '').trim());
  return m ? `${m[3]}-${pad2(m[2])}-${pad2(m[1])}` : String(s ?? '');
}

/** Русские окончания: 1 банка, 2 банки, 5 банок. */
const pluralRu = (n, forms) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
  return forms[2];
};

/**
 * Защиты по-английски (ключи — как в FAULT_BITS протокола).
 * В русском чеке для известных ключей берётся FAULT_NAMES_RU (те же слова, что и
 * на панели, и они гарантированно русские), для незнакомых — название с платы (label).
 */
export const FAULT_NAMES_EN = {
  covp: 'Cell overvoltage',
  cuvp: 'Cell undervoltage',
  povp: 'Pack overvoltage',
  puvp: 'Pack undervoltage',
  chgot: 'Charge over-temperature',
  chgut: 'Charge under-temperature',
  dsgot: 'Discharge over-temperature',
  dsgut: 'Discharge under-temperature',
  chgoc: 'Charge overcurrent',
  dsgoc: 'Discharge overcurrent',
  sc: 'Short circuit',
  afe: 'AFE chip error',
  software: 'Software lock',
};

export const FAULT_NAMES_RU = {
  covp: 'Перенапряжение ячейки',
  cuvp: 'Понижение ячейки',
  povp: 'Перенапряжение батареи',
  puvp: 'Понижение батареи',
  chgot: 'Перегрев заряда',
  chgut: 'Переохлаждение заряда',
  dsgot: 'Перегрев разряда',
  dsgut: 'Переохлаждение разряда',
  chgoc: 'Перегрузка заряда',
  dsgoc: 'Перегрузка разряда',
  sc: 'Короткое замыкание',
  afe: 'Ошибка чипа AFE',
  software: 'Программная блокировка',
};

const faultName = (f) => FAULT_NAMES_EN[f?.key] ?? (toPrinterText(f?.label || f?.key || '') || 'Unknown fault');
const faultNameRu = (f) => {
  const label = sanitizeText(f?.label || '').trim();
  return FAULT_NAMES_RU[f?.key] ?? (label || `Защита ${f?.key ?? '?'}`);
};

/**
 * Подписи чека. Английский набор — прежний, русский — короткие слова,
 * которые влезают в строку 24 символа рядом со значением.
 */
function labels(lang) {
  if (lang === 'ru') {
    return {
      bankTitle: 'АККУМУЛЯТОР',
      fleetTitle: 'ВСЕ АККУМУЛЯТОРЫ',
      fleetSubtitle: 'Сводный чек',
      report: 'Вид', status: 'Состояние', online: 'на связи', offline: 'НЕТ СВЯЗИ',
      onlineHead: 'На связи', offlineHead: 'Нет связи', updated: 'Обновлено', port: 'Порт',
      levels: { short: 'короткий', medium: 'средний', full: 'полный' },
      main: 'ОСНОВНЫЕ ЗНАЧЕНИЯ',
      voltage: 'Напряжение', current: 'Ток', power: 'Мощность', soc: 'Заряд', remaining: 'Остаток',
      cycles: 'Циклы', cellsInSeries: 'Банок в сборке', cells: 'Банок',
      cellsHead: 'БАНКИ', lowest: 'Мин. банка', highest: 'Макс. банка', average: 'Средняя', delta: 'Разброс Δ',
      noCellData: '- данных по банкам нет -',
      cellDetail: 'ПО БАНКАМ', deviation: 'отклонение от среднего', balancingMark: 'b = балансировка',
      legendMin: '! мин', legendMax: '^ макс', legendBal: 'b баланс',
      temps: 'ТЕМПЕРАТУРЫ', sensor: (i) => `Датчик ${i + 1}`, noSensors: '- датчиков нет -',
      maxTemp: 'Макс. температура', highLow: 'Макс / мин',
      switches: 'КЛЮЧИ И ЗАЩИТЫ', chargeFet: 'Ключ заряда', dischargeFet: 'Ключ разряда', balancing: 'Балансировка',
      balancingNone: 'нет', balancingCells: (n) => `${n} ${pluralRu(n, ['банка', 'банки', 'банок'])}`,
      protections: 'Защиты', noneActive: 'нет активных', active: (n) => `активно: ${n}`,
      faultRegister: 'Регистр защит',
      counters: 'СЧЁТЧИКИ ЗАЩИТ', allZero: '- все нули -',
      board: 'ПЛАТА', hardware: 'Версия платы', firmware: 'Прошивка', serial: 'Серийный №', manufactured: 'Выпущена',
      fleetOnline: (on, all) => `НА СВЯЗИ: ${on}/${all}`,
      totalCurrent: 'Суммарный ток', totalPower: 'Суммарная мощность', totalRemaining: 'Остаток всего',
      maxCellDelta: 'Макс. разброс', balancingCount: 'Балансируются', cyclesMax: 'Циклов (макс)',
      fetsOff: 'Ключи выкл з/р',
      boards: 'Плат', avgVoltage: 'Среднее напряжение', avgSoc: 'Средний заряд', activeProtections: 'Активных защит',
      maxPower: 'Макс. мощность', extremeCell: 'Крайние банки',
      batteries: 'АККУМУЛЯТОРЫ', noData: '- нет данных -', totalCurrentShort: 'Ток',
      min: 'мин', max: 'макс', chargeShort: 'Заряд', deltaShort: 'разброс',
      packUnit: { v: 'В', a: 'А', w: 'Вт', soc: '%', mv: 'мВ', ah: 'Ач' },
      model: 'Модель', footer: 'Напечатано JBD BMS',
      // короткие подписи для плотной строки фактов в полном чеке по парку
      facts: {
        sensors: (list) => `Датчики ${list} °C`,
        cycles: 'циклы', balancing: 'балансировка', chargeFet: 'ключ заряда', dischargeFet: 'ключ разряда',
        model: 'модель', hardware: 'плата', firmware: 'прошивка', serial: '№', made: 'выпуск',
      },
    };
  }
  return {
    bankTitle: 'BATTERY REPORT',
    fleetTitle: 'ALL BATTERIES',
    fleetSubtitle: 'Summary report',
    report: 'Report', status: 'Status', online: 'online', offline: 'OFFLINE',
    onlineHead: 'Online', offlineHead: 'Offline', updated: 'Updated', port: 'Port',
    levels: { short: 'short', medium: 'medium', full: 'full' },
    main: 'MAIN READINGS',
    voltage: 'Voltage', current: 'Current', power: 'Power', soc: 'State of charge', remaining: 'Remaining',
    cycles: 'Cycles', cellsInSeries: 'Cells in series', cells: 'Cells',
    cellsHead: 'CELLS', lowest: 'Lowest cell', highest: 'Highest cell', average: 'Average', delta: 'Delta (max-min)',
    noCellData: '- no cell data -',
    cellDetail: 'CELL DETAIL', deviation: 'deviation from average', balancingMark: 'b = balancing',
    legendMin: '! min', legendMax: '^ max', legendBal: 'b balancing',
    temps: 'TEMPERATURES', sensor: (i) => `Sensor T${i + 1}`, noSensors: '- no sensors -',
    maxTemp: 'Max temperature', highLow: 'High / low',
    switches: 'SWITCHES & PROTECTION', chargeFet: 'Charge FET', dischargeFet: 'Discharge FET', balancing: 'Balancing',
    balancingNone: 'none', balancingCells: (n) => `${n} cell${n === 1 ? '' : 's'}`,
    protections: 'Protections', noneActive: 'none active', active: (n) => `${n} ACTIVE`,
    faultRegister: 'Fault register',
    counters: 'PROTECTION COUNTERS', allZero: '- all zero -',
    board: 'BOARD', hardware: 'Hardware', firmware: 'Firmware', serial: 'Serial no.', manufactured: 'Manufactured',
    fleetOnline: (on, all) => `ALL BATTERIES: ${on}/${all} ONLINE`,
    totalCurrent: 'Total current', totalPower: 'Total power', totalRemaining: 'Total remaining',
    maxCellDelta: 'Max cell delta', balancingCount: 'Balancing cells', cyclesMax: 'Cycles (max)',
    fetsOff: 'FETs off chg/dsg',
    boards: 'Boards', avgVoltage: 'Average voltage', avgSoc: 'Average SOC', activeProtections: 'Active protections',
    maxPower: 'Max power', extremeCell: 'Extreme cell V',
    batteries: 'BATTERIES', noData: '- no data -', totalCurrentShort: 'Total current',
    min: 'min', max: 'max', chargeShort: 'SOC', deltaShort: 'delta',
    packUnit: { v: 'V', a: 'A', w: 'W', soc: '%', mv: 'mV', ah: 'Ah' },
    model: 'Model', footer: 'Printed by JBD BMS',
    facts: {
      sensors: (list) => `T ${list} C`,
      cycles: 'cycles', balancing: 'balancing', chargeFet: 'chg FET', dischargeFet: 'dsg FET',
      model: 'model', hardware: 'hw', firmware: 'fw', serial: 'sn', made: 'made',
    },
  };
}

/** Сложить короткие фрагменты в строки не шире width, не разрывая фрагмент. */
function packBits(bits, width, sep = '  ') {
  const out = [];
  let cur = '';
  for (const bit of bits.map((b) => sanitizeText(b)).filter(Boolean)) {
    if (!cur) cur = bit;
    else if (cur.length + sep.length + bit.length <= width) cur += sep + bit;
    else { out.push(cur); cur = bit; }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Ячейки компактной сеткой: «#01 3320mV» + метки (! — минимальная,
 * ^ — максимальная, b — балансируется). Колонок столько, сколько влезает.
 */
function cellGrid(cells, st, balancing, width, L, mv = 'mV') {
  const marked = st && st.delta > 0;
  const items = cells.map((v, i) => {
    let s = `#${pad2(i + 1)} ${isNum(v) ? Math.round(v) : '----'}${mv}`;
    if (marked && i === st.minIndex) s += '!';
    else if (marked && i === st.maxIndex) s += '^';
    if (balancing?.includes(i + 1)) s += 'b';
    return s;
  });
  const longest = Math.max(...items.map((s) => s.length));
  const perRow = Math.max(1, Math.min(4, Math.floor((width + 2) / (longest + 2))));
  const slot = Math.floor(width / perRow);
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) {
    const part = items.slice(i, i + perRow);
    rows.push(part.map((s, j) => (j < part.length - 1 ? s.padEnd(slot) : s)).join(''));
  }
  const legend = [];
  if (marked) legend.push(L.legendMin, L.legendMax);
  if (balancing?.length) legend.push(L.legendBal);
  return { rows, legend };
}

/** Пробная страница: проверка связи и ширины строки. Печатается на языке чека. */
function buildTestPage({ path, baudRate, width, language = 'en' }) {
  const ru = language === 'ru';
  const ruler = Array.from({ length: width }, (_, i) => String((i + 1) % 10)).join('');
  return [
    { t: 'text', text: 'JBD BMS', align: 1, bold: true, size: 'big' },
    { t: 'text', text: ru ? 'ПРОБНАЯ СТРАНИЦА' : 'PRINTER TEST', align: 1, bold: true },
    { t: 'divider' },
    { t: 'row', left: ru ? 'Порт' : 'Port', right: path },
    { t: 'row', left: ru ? 'Скорость' : 'Baud rate', right: `${baudRate} ${ru ? 'бод' : 'baud'}` },
    { t: 'row', left: ru ? 'Ширина' : 'Line width', right: `${width} ${ru ? 'симв.' : 'chars'}` },
    { t: 'row', left: ru ? 'Язык' : 'Language', right: ru ? 'Русский' : 'English (ASCII)' },
    { t: 'divider' },
    { t: 'text', text: ru ? 'Если этот текст читается — принтер работает.' : 'If you can read this text, the printer works.' },
    { t: 'blank', n: 1 },
    { t: 'text', text: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    { t: 'text', text: 'abcdefghijklmnopqrstuvwxyz' },
    { t: 'text', text: '0123456789 +-*/=%#.,:;!?()[]' },
    { t: 'blank', n: 1 },
    { t: 'text', text: ru ? 'Проверка ширины (одна строка = норма):' : 'Width check (1 line = OK):' },
    { t: 'text', text: ruler },
    { t: 'blank', n: 1 },
    { t: 'text', text: (ru ? FMT_RU : FMT_EN).time(Date.now()), align: 1 },
    { t: 'feed', n: 4 },
  ];
}

/**
 * Блок для перебора скоростей: на «своей» скорости текст читается, на чужой
 * выходит мусор — по бумаге видно, какая строка настоящая.
 * Всегда ASCII: он должен быть понятен даже при неверной кодовой странице.
 */
function baudSweepLines(baudRate, framing) {
  return [
    { t: 'divider', ch: '=' },
    { t: 'text', text: `${baudRate} ${framing}`, align: 1, bold: true },
    { t: 'text', text: 'Hello 123 ABC abc +-*/' },
    { t: 'feed', n: 2 },
  ];
}

/**
 * Чек по одному аккумулятору. Вид чека (level) решает, сколько блоков попадёт
 * на бумагу: короткий — только главное, средний — ещё сетка банок и температуры,
 * полный — плюс каждая банка строкой, счётчики защит, паспорт платы и итоги парка.
 * Язык (language) выбирает подписи: английские ASCII или русские (cp866/cp1251/utf8).
 */
function buildBankReceipt(b, fleet, width = 32, level = DEFAULT_REPORT_LEVEL, language = 'en') {
  const lvl = levelOf(level);
  const ru = language === 'ru';
  const L = labels(ru ? 'ru' : 'en');
  const F = ru ? FMT_RU : FMT_EN;
  const faultOf = ru ? faultNameRu : faultName;
  const brief = lvl === 'short';
  const full = lvl === 'full';
  const st = b.stats;
  const T = b.temperatures || [];
  const cells = b.cells || [];
  const lines = [];
  lines.push({ t: 'text', text: L.bankTitle, align: 1, bold: true, size: 'big' });
  lines.push({ t: 'text', text: b.label, align: 1, bold: true });
  if (b.deviceName && b.deviceName !== b.label) lines.push({ t: 'text', text: b.deviceName, align: 1 });
  if (b.model) lines.push({ t: 'text', text: `${L.model}: ${b.model}`, align: 1 });
  lines.push({ t: 'divider' });

  lines.push({ t: 'row', left: L.report, right: L.levels[lvl] });
  lines.push({ t: 'row', left: L.status, right: b.connected ? L.online : L.offline });
  lines.push({ t: 'row', left: L.updated, right: F.time(b.at) });
  if (!brief) lines.push({ t: 'row', left: L.port, right: b.demo ? 'demo' : b.path });
  lines.push({ t: 'divider' });

  // В коротком чеке заголовки блоков не печатаются: экономим строки бумаги.
  if (!brief) lines.push({ t: 'text', text: L.main, bold: true });
  lines.push({ t: 'row', left: L.voltage, right: F.num(b.voltage, 2, L.packUnit.v) });
  lines.push({ t: 'row', left: L.current, right: F.num(b.current, 2, L.packUnit.a) });
  lines.push({ t: 'row', left: L.power, right: F.num(b.power, 1, L.packUnit.w) });
  lines.push({ t: 'row', left: L.soc, right: F.num(b.soc, 0, L.packUnit.soc) });
  lines.push({ t: 'row', left: L.remaining, right: F.ah(b.remainingAh, b.fullAh) });
  if (!brief) lines.push({ t: 'row', left: L.cycles, right: isNum(b.cycles) ? String(b.cycles) : F.na });
  lines.push({ t: 'row', left: brief ? L.cells : L.cellsInSeries, right: `${b.cellCount || cells.length}S` });
  lines.push({ t: 'divider' });

  if (!brief) lines.push({ t: 'text', text: L.cellsHead, bold: true });
  if (st) {
    lines.push({ t: 'row', left: L.lowest, right: `#${st.minIndex + 1}  ${F.volts(st.min)}` });
    lines.push({ t: 'row', left: L.highest, right: `#${st.maxIndex + 1}  ${F.volts(st.max)}` });
    if (!brief) lines.push({ t: 'row', left: L.average, right: F.volts(st.avg) });
    lines.push({ t: 'row', left: L.delta, right: F.num(st.delta, 0, L.packUnit.mv) });
  } else {
    lines.push({ t: 'text', text: L.noCellData });
  }
  if (cells.length && !brief) {
    const grid = cellGrid(cells, st, b.balancingCells, width, L, L.packUnit.mv);
    lines.push({ t: 'blank', n: 1 });
    for (const row of grid.rows) lines.push({ t: 'text', text: row });
    for (const row of packBits(grid.legend, width)) lines.push({ t: 'text', text: row });
  }
  if (cells.length && full) {
    // полный чек: каждая банка отдельной строкой с отклонением и меткой балансировки
    const bal = new Set(b.balancingCells ?? []);
    lines.push({ t: 'blank', n: 1 });
    for (const part of packBits([L.cellDetail, L.deviation, L.balancingMark], width)) {
      lines.push({ t: 'text', text: part });
    }
    cells.forEach((mv, i) => {
      const dev = st ? Math.round(mv - st.avg) : null;
      const devText = dev == null ? '' : `  ${dev > 0 ? '+' : ''}${ru ? String(dev).replace('.', ',') : dev} ${L.packUnit.mv}`;
      lines.push({ t: 'text', text: `#${pad2(i + 1)}  ${F.volts(mv)}${devText}${bal.has(i + 1) ? '  b' : ''}` });
    });
  }
  lines.push({ t: 'divider' });

  if (!brief) lines.push({ t: 'text', text: L.temps, bold: true });
  if (T.length) {
    if (brief) {
      lines.push({ t: 'row', left: L.maxTemp, right: F.temp(Math.max(...T)) });
    } else {
      T.forEach((t, i) => lines.push({ t: 'row', left: L.sensor(i), right: F.temp(t) }));
      if (full && T.length > 1) lines.push({ t: 'row', left: L.highLow, right: `${F.temp(Math.max(...T))} / ${F.temp(Math.min(...T))}` });
    }
  } else {
    lines.push({ t: 'text', text: L.noSensors });
  }
  lines.push({ t: 'divider' });

  if (brief) {
    // короткий чек: только счётчик защит и первые срабатывания
    lines.push({ t: 'row', left: L.protections, right: b.faults?.length ? L.active(b.faults.length) : L.noneActive, bold: Boolean(b.faults?.length) });
    for (const f of (b.faults ?? []).slice(0, 2)) lines.push({ t: 'text', text: `! ${faultOf(f)}` });
  } else {
    lines.push({ t: 'text', text: L.switches, bold: true });
    lines.push({ t: 'row', left: L.chargeFet, right: F.onOff(b.chargeFetOn) });
    lines.push({ t: 'row', left: L.dischargeFet, right: F.onOff(b.dischargeFetOn) });
    lines.push({ t: 'row', left: L.balancing, right: b.balancingCells?.length ? L.balancingCells(b.balancingCells.length) : L.balancingNone });
    if (b.faults?.length) {
      lines.push({ t: 'row', left: L.protections, right: L.active(b.faults.length), bold: true });
      for (const f of b.faults.slice(0, 13)) lines.push({ t: 'text', text: `! ${faultOf(f)}` });
    } else {
      lines.push({ t: 'row', left: L.protections, right: L.noneActive });
    }
    if (full && isNum(b.faultRaw)) {
      lines.push({ t: 'row', left: L.faultRegister, right: `0x${(b.faultRaw >>> 0).toString(16).padStart(4, '0')}` });
    }
  }
  lines.push({ t: 'divider' });

  if (full) {
    // счётчики срабатываний защит (регистр 0xAA): ненулевые — история платы
    const counters = Object.entries(b.errors ?? {}).filter(([, v]) => isNum(v) && v > 0);
    lines.push({ t: 'text', text: L.counters, bold: true });
    if (counters.length) {
      for (const [key, v] of counters) lines.push({ t: 'row', left: faultOf({ key }), right: String(v) });
    } else {
      lines.push({ t: 'text', text: L.allZero });
    }
    lines.push({ t: 'divider' });
  }

  if (full && (b.hwVersion || b.swVersion || b.serial || b.prodDate)) {
    lines.push({ t: 'text', text: L.board, bold: true });
    if (b.hwVersion) lines.push({ t: 'row', left: L.hardware, right: b.hwVersion });
    if (b.swVersion) lines.push({ t: 'row', left: L.firmware, right: b.swVersion });
    if (b.serial) lines.push({ t: 'row', left: L.serial, right: b.serial });
    if (b.prodDate) lines.push({ t: 'row', left: L.manufactured, right: ru ? String(b.prodDate) : isoDate(b.prodDate) });
    lines.push({ t: 'divider' });
  }

  if (fleet && fleet.banks > 1 && !brief) {
    lines.push({ t: 'text', text: L.fleetOnline(fleet.online, fleet.banks), bold: true, align: 1 });
    lines.push({ t: 'row', left: L.totalCurrent, right: F.num(fleet.currentSum, 2, L.packUnit.a) });
    lines.push({ t: 'row', left: L.totalPower, right: F.num(fleet.powerSum, 1, L.packUnit.w) });
    lines.push({ t: 'row', left: L.totalRemaining, right: F.ah(fleet.ahSum, fleet.ahCapacity, 1) });
    lines.push({ t: 'row', left: L.maxCellDelta, right: F.num(fleet.cellDelta, 0, L.packUnit.mv) });
    lines.push({ t: 'row', left: L.maxTemp, right: F.temp(fleet.tempMax) });
    if (full) {
      lines.push({ t: 'row', left: L.balancingCount, right: String(fleet.balancing ?? 0) });
      lines.push({ t: 'row', left: L.cyclesMax, right: isNum(fleet.cyclesMax) ? String(fleet.cyclesMax) : F.na });
      lines.push({ t: 'row', left: L.fetsOff, right: `${fleet.chargeFetOff ?? 0}/${fleet.dischargeFetOff ?? 0}` });
    }
    lines.push({ t: 'divider' });
  }

  lines.push({ t: 'text', text: L.footer, align: 1 });
  lines.push({ t: 'text', text: F.time(Date.now()), align: 1 });
  lines.push({ t: 'feed', n: 4 });
  return lines;
}

/**
 * Чек по всем аккумуляторам (парку). Короткий — итоги и по одной-две строки на плату,
 * средний — по три строки на плату, полный — плюс температуры, циклы, ключи,
 * паспорт каждой платы и все активные защиты.
 */
function buildFleetReceipt(rows, fleet, width = 32, level = DEFAULT_REPORT_LEVEL, language = 'en') {
  const lvl = levelOf(level);
  const ru = language === 'ru';
  const L = labels(ru ? 'ru' : 'en');
  const F = ru ? FMT_RU : FMT_EN;
  const faultOf = ru ? faultNameRu : faultName;
  const brief = lvl === 'short';
  const full = lvl === 'full';
  const lines = [];
  lines.push({ t: 'text', text: L.fleetTitle, align: 1, bold: true, size: 'big' });
  lines.push({ t: 'text', text: L.fleetSubtitle, align: 1, bold: true });
  lines.push({ t: 'divider' });
  lines.push({ t: 'row', left: L.report, right: L.levels[lvl] });
  lines.push({ t: 'row', left: L.boards, right: String(fleet?.banks ?? rows.length) });
  lines.push({ t: 'row', left: L.onlineHead, right: String(fleet?.online ?? rows.filter((r) => r.connected).length) });
  lines.push({ t: 'row', left: L.offlineHead, right: String(fleet?.stale ?? rows.filter((r) => !r.connected).length) });
  lines.push({ t: 'row', left: L.avgVoltage, right: F.num(fleet?.voltageAvg, 2, L.packUnit.v) });
  lines.push({ t: 'row', left: L.totalCurrentShort, right: F.num(fleet?.currentSum, 2, L.packUnit.a) });
  lines.push({ t: 'row', left: L.totalPower, right: F.num(fleet?.powerSum, 1, L.packUnit.w) });
  lines.push({ t: 'row', left: L.totalRemaining, right: F.ah(fleet?.ahSum, fleet?.ahCapacity, 1) });
  lines.push({ t: 'row', left: L.avgSoc, right: F.num(fleet?.socAvg, 0, L.packUnit.soc) });
  lines.push({ t: 'row', left: L.maxCellDelta, right: F.num(fleet?.cellDelta, 0, L.packUnit.mv) });
  lines.push({ t: 'row', left: L.maxTemp, right: F.temp(fleet?.tempMax) });
  lines.push({ t: 'row', left: L.activeProtections, right: String(fleet?.faults ?? 0) });
  if (full) {
    lines.push({ t: 'row', left: L.maxPower, right: F.num(fleet?.powerMax, 1, L.packUnit.w) });
    lines.push({ t: 'row', left: L.extremeCell, right: `${F.volts(fleet?.cellMin)} / ${F.volts(fleet?.cellMax)}` });
    lines.push({ t: 'row', left: L.balancingCount, right: String(fleet?.balancing ?? 0) });
    lines.push({ t: 'row', left: L.cyclesMax, right: isNum(fleet?.cyclesMax) ? String(fleet.cyclesMax) : F.na });
    lines.push({ t: 'row', left: L.fetsOff, right: `${fleet?.chargeFetOff ?? 0}/${fleet?.dischargeFetOff ?? 0}` });
  }
  lines.push({ t: 'divider' });

  lines.push({ t: 'text', text: L.batteries, bold: true });
  rows.forEach((b, i) => {
    const st = b.stats;
    if (i > 0 && !brief) lines.push({ t: 'blank', n: 1 });
    lines.push({ t: 'text', text: `${i + 1}. ${b.label} - ${b.connected ? L.online : L.offline}`, bold: true });
    if (!isNum(b.voltage) && !isNum(b.current) && !st) {
      lines.push({ t: 'text', text: L.noData });
    } else if (brief) {
      // короткий чек: одна-две строки на плату — электрика и заряд
      const facts = [
        F.num(b.voltage, 2, L.packUnit.v), F.num(b.current, 2, L.packUnit.a),
        `${L.chargeShort} ${F.num(b.soc, 0, L.packUnit.soc)}`, st ? `${L.deltaShort} ${st.delta} ${L.packUnit.mv}` : '',
      ];
      for (const s of packBits(facts, width)) lines.push({ t: 'text', text: s });
    } else {
      // средний чек: три смысловые строки — электрика · заряд и банки · крайние банки
      const groups = [
        [F.num(b.voltage, 2, L.packUnit.v), F.num(b.current, 1, L.packUnit.a), F.num(b.power, 0, L.packUnit.w)],
        [`${L.chargeShort} ${F.num(b.soc, 0, L.packUnit.soc)}`, `${b.cellCount || b.cells?.length || 0}S`, st ? `${L.deltaShort} ${st.delta} ${L.packUnit.mv}` : ''],
        st ? [`${L.min} ${F.volts(st.min)}`, `${L.max} ${F.volts(st.max)}`] : [],
      ];
      for (const g of groups) for (const s of packBits(g, width)) lines.push({ t: 'text', text: s });
    }
    if (full) {
      // полный чек: температуры, циклы, ключи и паспорт платы
      const extra = [
        b.temperatures?.length
          ? L.facts.sensors(b.temperatures.map((t) => (isNum(t) ? (ru ? t.toFixed(1).replace('.', ',') : t.toFixed(1)) : F.na)).join('/'))
          : '',
        `${L.facts.cycles} ${isNum(b.cycles) ? b.cycles : F.na}`,
        `${L.facts.balancing} ${b.balancingCells?.length ?? 0}`,
        `${L.facts.chargeFet} ${F.onOff(b.chargeFetOn)}`,
        `${L.facts.dischargeFet} ${F.onOff(b.dischargeFetOn)}`,
        b.model ? `${L.facts.model} ${b.model}` : '',
        b.hwVersion ? `${L.facts.hardware} ${b.hwVersion}` : '',
        b.swVersion ? `${L.facts.firmware} ${b.swVersion}` : '',
        b.serial ? `${L.facts.serial} ${b.serial}` : '',
        b.prodDate ? `${L.facts.made} ${ru ? b.prodDate : isoDate(b.prodDate)}` : '',
      ];
      for (const s of packBits(extra, width)) lines.push({ t: 'text', text: s });
    }
    const faults = brief ? (b.faults ?? []).slice(0, 2) : (b.faults ?? []);
    for (const f of faults) lines.push({ t: 'text', text: `! ${faultOf(f)}` });
  });
  lines.push({ t: 'divider' });
  lines.push({ t: 'text', text: L.footer, align: 1 });
  lines.push({ t: 'text', text: F.time(Date.now()), align: 1 });
  lines.push({ t: 'feed', n: 4 });
  return lines;
}

function svcError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

export {
  buildBankReceipt, buildFleetReceipt, buildTestPage, baudSweepLines, PRINTER_BAUDS,
  PRINTER_LANGUAGES, PRINTER_CHARSETS, CHARSET_CODEPAGE,
};
