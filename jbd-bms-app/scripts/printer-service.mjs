// Сервис управления UART-чековым принтером: конфигурация, подключение,
// форматирование сводки и печать по протоколу AlexGyver/Printer
// (TTL UART, 5–9 В, типично 9600/19200 8N1).
//
// Чеки на английском, данные приводятся к ASCII. Читаемость требует
// совпадения скорости UART и протокола; ASCII сам по себе это не гарантирует. Подписи банков, имена плат и т. п. из
// данных приводятся к ASCII транслитом.

import { ReceiptPrinter, PRINTER_BAUDS, renderReceiptText, toPrinterText, PRINTER_PROFILES, PRINTER_FRAMINGS, STATUS_QUERIES, describeStatusByte, plainReceipt } from './printer.mjs';

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
        // старый printer.json без вида чека (или с опечаткой) не должен терять весь файл
        if (saved && !REPORT_LEVELS.includes(saved.reportLevel)) delete saved.reportLevel;
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
      printing: this.printing,
      language: 'en',
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
    this.log(`конфигурация: ${this.config.path || '(не выбран)'} @ ${this.config.baudRate} ${this.config.framing}, ширина ${this.config.width}, чек ${this.config.reportLevel} на английском (ASCII)`);
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
      });
    }
    // ширина могла поменяться после первой печати — порт ради этого не переоткрываем
    this.printer.width = this.config.width;
    this.printer.profile = this.config.profile;
    this.printer.lineDelayMs = this.config.lineDelayMs;
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
      return { ok: true, at: this.lastPrintAt, message: 'Байты отправлены. Подтвердите читаемость на бумаге.' };
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
      await p.printLines(buildTestPage({ path: p.path, baudRate: p.baudRate, width: p.width }));
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
   */
  async printBank(bankRow, fleet = null, level = null) {
    if (this.printing) throw svcError(409, 'PRINTER_BUSY', 'Принтер уже печатает.');
    const lvl = this._level(level);
    const p = this._ensure();
    this.printing = true;
    try {
      await this._closing;
      await p.open();
      await p.printLines(buildBankReceipt(bankRow, fleet, p.width, lvl));
      this.lastError = '';
      this.lastPrintAt = Date.now();
      return { ok: true, at: this.lastPrintAt, bank: bankRow.label, path: p.path, level: lvl };
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
   */
  async printFleet(rows, fleet, level = null) {
    if (this.printing) throw svcError(409, 'PRINTER_BUSY', 'Принтер уже печатает.');
    const lvl = this._level(level);
    const p = this._ensure();
    this.printing = true;
    try {
      await this._closing;
      await p.open();
      await p.printLines(buildFleetReceipt(rows, fleet, p.width, lvl));
      this.lastError = '';
      this.lastPrintAt = Date.now();
      return { ok: true, at: this.lastPrintAt, banks: rows.length, path: p.path, level: lvl };
    } catch (e) {
      this.lastError = e.message;
      throw svcError(502, 'PRINT_FAILED', `Печать сводки по парку не удалась: ${e.message}`);
    } finally { this.printing = false; }
  }

  // ---------- предпросмотр: тот же чек обычным текстом, без принтера ----------

  _render(lines, width) {
    return renderReceiptText(this.config.profile === 'plain' ? plainReceipt(lines) : lines, width);
  }

  previewTest() {
    const width = this.config.width;
    const lines = buildTestPage({ path: this.config.path || '(not selected)', baudRate: this.config.baudRate, width });
    return { kind: 'test', level: null, width, lines: this._render(lines, width) };
  }

  previewBank(bankRow, fleet = null, level = null) {
    const width = this.config.width;
    const lvl = this._level(level);
    return { kind: 'bank', level: lvl, width, lines: this._render(buildBankReceipt(bankRow, fleet, width, lvl), width) };
  }

  previewFleet(rows, fleet, level = null) {
    const width = this.config.width;
    const lvl = this._level(level);
    return { kind: 'fleet', level: lvl, width, lines: this._render(buildFleetReceipt(rows, fleet, width, lvl), width) };
  }

  async close() {
    await this._closing;
    if (this.printer) await this.printer.close().catch(() => {});
    this.printer = null;
  }
}

// ---------- форматирование чека: английский текст, только ASCII ----------

const pad2 = (v) => String(v).padStart(2, '0');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** Число с десятичной точкой и единицей: «41.23 V»; нет значения — «n/a». */
const num = (v, d = 0, unit = '') => (isNum(v) ? `${v.toFixed(d)}${unit ? ` ${unit}` : ''}` : 'n/a');
/** Милливольты → вольты с тремя знаками: 3301 → «3.301 V». */
const volts = (mv) => (isNum(mv) ? `${(mv / 1000).toFixed(3)} V` : 'n/a');
/** Температура: −999 и ниже абсолютного нуля значит «датчиков нет». */
const temp = (t) => (isNum(t) && t > -273 ? `${t.toFixed(1)} C` : 'n/a');
const onOff = (v) => (v === null || v === undefined ? 'n/a' : v ? 'on' : 'OFF');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Остаток / полная ёмкость, А·ч. */
const ah = (rem, full, d = 2) => {
  if (!isNum(rem)) return 'n/a';
  return isNum(full) ? `${rem.toFixed(d)} / ${full.toFixed(d)} Ah` : `${rem.toFixed(d)} Ah`;
};

/** Время «ГГГГ-ММ-ДД ЧЧ:ММ» — однозначно для английского чека. */
function fmtTime(ts) {
  if (!ts) return 'n/a';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Дата паспорта платы «ДД.ММ.ГГГГ» → «ГГГГ-ММ-ДД». */
function isoDate(s) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(String(s ?? '').trim());
  return m ? `${m[3]}-${pad2(m[2])}-${pad2(m[1])}` : String(s ?? '');
}

/** Защиты по-английски (ключи — как в FAULT_BITS протокола). */
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
const faultName = (f) => FAULT_NAMES_EN[f?.key] ?? (toPrinterText(f?.label || f?.key || '') || 'Unknown fault');

/** Сложить короткие фрагменты в строки не шире width, не разрывая фрагмент. */
function packBits(bits, width, sep = '  ') {
  const out = [];
  let cur = '';
  for (const bit of bits.map((b) => toPrinterText(b)).filter(Boolean)) {
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
function cellGrid(cells, st, balancing, width) {
  const marked = st && st.delta > 0;
  const items = cells.map((v, i) => {
    let s = `#${pad2(i + 1)} ${isNum(v) ? Math.round(v) : '----'}mV`;
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
  if (marked) legend.push('! min', '^ max');
  if (balancing?.length) legend.push('b balancing');
  return { rows, legend };
}

function buildTestPage({ path, baudRate, width }) {
  const ruler = Array.from({ length: width }, (_, i) => String((i + 1) % 10)).join('');
  return [
    { t: 'text', text: 'JBD BMS', align: 1, bold: true, size: 'big' },
    { t: 'text', text: 'PRINTER TEST', align: 1, bold: true },
    { t: 'divider' },
    { t: 'row', left: 'Port', right: path },
    { t: 'row', left: 'Baud rate', right: `${baudRate} baud` },
    { t: 'row', left: 'Line width', right: `${width} chars` },
    { t: 'row', left: 'Language', right: 'English (ASCII)' },
    { t: 'divider' },
    { t: 'text', text: 'If you can read this text, the printer works.' },
    { t: 'blank', n: 1 },
    { t: 'text', text: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    { t: 'text', text: 'abcdefghijklmnopqrstuvwxyz' },
    { t: 'text', text: '0123456789 +-*/=%#.,:;!?()[]' },
    { t: 'blank', n: 1 },
    { t: 'text', text: 'Width check (1 line = OK):' },
    { t: 'text', text: ruler },
    { t: 'blank', n: 1 },
    { t: 'text', text: fmtTime(Date.now()), align: 1 },
    { t: 'feed', n: 4 },
  ];
}

/**
 * Блок для перебора скоростей: на «своей» скорости текст читается, на чужой
 * выходит мусор — по бумаге видно, какая строка настоящая.
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
 */
function buildBankReceipt(b, fleet, width = 32, level = DEFAULT_REPORT_LEVEL) {
  const lvl = levelOf(level);
  const brief = lvl === 'short';
  const full = lvl === 'full';
  const st = b.stats;
  const T = b.temperatures || [];
  const cells = b.cells || [];
  const lines = [];
  lines.push({ t: 'text', text: 'BATTERY REPORT', align: 1, bold: true, size: 'big' });
  lines.push({ t: 'text', text: b.label, align: 1, bold: true });
  if (b.deviceName && b.deviceName !== b.label) lines.push({ t: 'text', text: b.deviceName, align: 1 });
  if (b.model) lines.push({ t: 'text', text: `Model: ${b.model}`, align: 1 });
  lines.push({ t: 'divider' });

  lines.push({ t: 'row', left: 'Report', right: lvl });
  lines.push({ t: 'row', left: 'Status', right: b.connected ? 'online' : 'OFFLINE' });
  lines.push({ t: 'row', left: 'Updated', right: fmtTime(b.at) });
  if (!brief) lines.push({ t: 'row', left: 'Port', right: b.demo ? 'demo' : b.path });
  lines.push({ t: 'divider' });

  // В коротком чеке заголовки блоков не печатаются: экономим строки бумаги.
  if (!brief) lines.push({ t: 'text', text: 'MAIN READINGS', bold: true });
  lines.push({ t: 'row', left: 'Voltage', right: num(b.voltage, 2, 'V') });
  lines.push({ t: 'row', left: 'Current', right: num(b.current, 2, 'A') });
  lines.push({ t: 'row', left: 'Power', right: num(b.power, 1, 'W') });
  lines.push({ t: 'row', left: 'State of charge', right: num(b.soc, 0, '%') });
  lines.push({ t: 'row', left: 'Remaining', right: ah(b.remainingAh, b.fullAh) });
  if (!brief) lines.push({ t: 'row', left: 'Cycles', right: isNum(b.cycles) ? String(b.cycles) : 'n/a' });
  lines.push({ t: 'row', left: brief ? 'Cells' : 'Cells in series', right: `${b.cellCount || cells.length}S` });
  lines.push({ t: 'divider' });

  if (!brief) lines.push({ t: 'text', text: 'CELLS', bold: true });
  if (st) {
    lines.push({ t: 'row', left: 'Lowest cell', right: `#${st.minIndex + 1}  ${volts(st.min)}` });
    lines.push({ t: 'row', left: 'Highest cell', right: `#${st.maxIndex + 1}  ${volts(st.max)}` });
    if (!brief) lines.push({ t: 'row', left: 'Average', right: volts(st.avg) });
    lines.push({ t: 'row', left: 'Delta (max-min)', right: num(st.delta, 0, 'mV') });
  } else {
    lines.push({ t: 'text', text: '- no cell data -' });
  }
  if (cells.length && !brief) {
    const grid = cellGrid(cells, st, b.balancingCells, width);
    lines.push({ t: 'blank', n: 1 });
    for (const row of grid.rows) lines.push({ t: 'text', text: row });
    for (const row of packBits(grid.legend, width)) lines.push({ t: 'text', text: row });
  }
  if (cells.length && full) {
    // полный чек: каждая банка отдельной строкой с отклонением и меткой балансировки
    const bal = new Set(b.balancingCells ?? []);
    lines.push({ t: 'blank', n: 1 });
    for (const part of packBits(['CELL DETAIL', 'deviation from average', 'b = balancing'], width)) {
      lines.push({ t: 'text', text: part });
    }
    cells.forEach((mv, i) => {
      const dev = st ? Math.round(mv - st.avg) : null;
      const devText = dev == null ? '' : `  ${dev > 0 ? '+' : ''}${dev} mV`;
      lines.push({ t: 'text', text: `#${pad2(i + 1)}  ${volts(mv)}${devText}${bal.has(i + 1) ? '  b' : ''}` });
    });
  }
  lines.push({ t: 'divider' });

  if (!brief) lines.push({ t: 'text', text: 'TEMPERATURES', bold: true });
  if (T.length) {
    if (brief) {
      lines.push({ t: 'row', left: 'Max temperature', right: temp(Math.max(...T)) });
    } else {
      T.forEach((t, i) => lines.push({ t: 'row', left: `Sensor T${i + 1}`, right: temp(t) }));
      if (full && T.length > 1) lines.push({ t: 'row', left: 'High / low', right: `${temp(Math.max(...T))} / ${temp(Math.min(...T))}` });
    }
  } else {
    lines.push({ t: 'text', text: '- no sensors -' });
  }
  lines.push({ t: 'divider' });

  if (brief) {
    // короткий чек: только счётчик защит и первые срабатывания
    lines.push({ t: 'row', left: 'Protections', right: b.faults?.length ? `${b.faults.length} ACTIVE` : 'none active', bold: Boolean(b.faults?.length) });
    for (const f of (b.faults ?? []).slice(0, 2)) lines.push({ t: 'text', text: `! ${faultName(f)}` });
  } else {
    lines.push({ t: 'text', text: 'SWITCHES & PROTECTION', bold: true });
    lines.push({ t: 'row', left: 'Charge FET', right: onOff(b.chargeFetOn) });
    lines.push({ t: 'row', left: 'Discharge FET', right: onOff(b.dischargeFetOn) });
    lines.push({ t: 'row', left: 'Balancing', right: b.balancingCells?.length ? plural(b.balancingCells.length, 'cell') : 'none' });
    if (b.faults?.length) {
      lines.push({ t: 'row', left: 'Protections', right: `${b.faults.length} ACTIVE`, bold: true });
      for (const f of b.faults.slice(0, 13)) lines.push({ t: 'text', text: `! ${faultName(f)}` });
    } else {
      lines.push({ t: 'row', left: 'Protections', right: 'none active' });
    }
    if (full && isNum(b.faultRaw)) {
      lines.push({ t: 'row', left: 'Fault register', right: `0x${(b.faultRaw >>> 0).toString(16).padStart(4, '0')}` });
    }
  }
  lines.push({ t: 'divider' });

  if (full) {
    // счётчики срабатываний защит (регистр 0xAA): ненулевые — история платы
    const counters = Object.entries(b.errors ?? {}).filter(([, v]) => isNum(v) && v > 0);
    lines.push({ t: 'text', text: 'PROTECTION COUNTERS', bold: true });
    if (counters.length) {
      for (const [key, v] of counters) lines.push({ t: 'row', left: faultName({ key }), right: String(v) });
    } else {
      lines.push({ t: 'text', text: '- all zero -' });
    }
    lines.push({ t: 'divider' });
  }

  if (full && (b.hwVersion || b.swVersion || b.serial || b.prodDate)) {
    lines.push({ t: 'text', text: 'BOARD', bold: true });
    if (b.hwVersion) lines.push({ t: 'row', left: 'Hardware', right: b.hwVersion });
    if (b.swVersion) lines.push({ t: 'row', left: 'Firmware', right: b.swVersion });
    if (b.serial) lines.push({ t: 'row', left: 'Serial no.', right: b.serial });
    if (b.prodDate) lines.push({ t: 'row', left: 'Manufactured', right: isoDate(b.prodDate) });
    lines.push({ t: 'divider' });
  }

  if (fleet && fleet.banks > 1 && !brief) {
    lines.push({ t: 'text', text: `ALL BATTERIES: ${fleet.online}/${fleet.banks} ONLINE`, bold: true, align: 1 });
    lines.push({ t: 'row', left: 'Total current', right: num(fleet.currentSum, 2, 'A') });
    lines.push({ t: 'row', left: 'Total power', right: num(fleet.powerSum, 1, 'W') });
    lines.push({ t: 'row', left: 'Total remaining', right: ah(fleet.ahSum, fleet.ahCapacity, 1) });
    lines.push({ t: 'row', left: 'Max cell delta', right: num(fleet.cellDelta, 0, 'mV') });
    lines.push({ t: 'row', left: 'Max temperature', right: temp(fleet.tempMax) });
    if (full) {
      lines.push({ t: 'row', left: 'Balancing cells', right: String(fleet.balancing ?? 0) });
      lines.push({ t: 'row', left: 'Cycles (max)', right: isNum(fleet.cyclesMax) ? String(fleet.cyclesMax) : 'n/a' });
      lines.push({ t: 'row', left: 'FETs off chg/dsg', right: `${fleet.chargeFetOff ?? 0}/${fleet.dischargeFetOff ?? 0}` });
    }
    lines.push({ t: 'divider' });
  }

  lines.push({ t: 'text', text: 'Printed by JBD BMS', align: 1 });
  lines.push({ t: 'text', text: fmtTime(Date.now()), align: 1 });
  lines.push({ t: 'feed', n: 4 });
  return lines;
}

/**
 * Чек по всем аккумуляторам (парку). Короткий — итоги и по одной строке на плату,
 * средний — по три строки на плату, полный — плюс температуры, циклы, ключи,
 * паспорт каждой платы и все активные защиты.
 */
function buildFleetReceipt(rows, fleet, width = 32, level = DEFAULT_REPORT_LEVEL) {
  const lvl = levelOf(level);
  const brief = lvl === 'short';
  const full = lvl === 'full';
  const lines = [];
  lines.push({ t: 'text', text: 'ALL BATTERIES', align: 1, bold: true, size: 'big' });
  lines.push({ t: 'text', text: 'Summary report', align: 1, bold: true });
  lines.push({ t: 'divider' });
  lines.push({ t: 'row', left: 'Report', right: lvl });
  lines.push({ t: 'row', left: 'Boards', right: String(fleet?.banks ?? rows.length) });
  lines.push({ t: 'row', left: 'Online', right: String(fleet?.online ?? rows.filter((r) => r.connected).length) });
  lines.push({ t: 'row', left: 'Offline', right: String(fleet?.stale ?? rows.filter((r) => !r.connected).length) });
  lines.push({ t: 'row', left: 'Average voltage', right: num(fleet?.voltageAvg, 2, 'V') });
  lines.push({ t: 'row', left: 'Total current', right: num(fleet?.currentSum, 2, 'A') });
  lines.push({ t: 'row', left: 'Total power', right: num(fleet?.powerSum, 1, 'W') });
  lines.push({ t: 'row', left: 'Total remaining', right: ah(fleet?.ahSum, fleet?.ahCapacity, 1) });
  lines.push({ t: 'row', left: 'Average SOC', right: num(fleet?.socAvg, 0, '%') });
  lines.push({ t: 'row', left: 'Max cell delta', right: num(fleet?.cellDelta, 0, 'mV') });
  lines.push({ t: 'row', left: 'Max temperature', right: temp(fleet?.tempMax) });
  lines.push({ t: 'row', left: 'Active protections', right: String(fleet?.faults ?? 0) });
  if (full) {
    lines.push({ t: 'row', left: 'Max power', right: num(fleet?.powerMax, 1, 'W') });
    lines.push({ t: 'row', left: 'Extreme cell V', right: `${volts(fleet?.cellMin)} / ${volts(fleet?.cellMax)}` });
    lines.push({ t: 'row', left: 'Balancing cells', right: String(fleet?.balancing ?? 0) });
    lines.push({ t: 'row', left: 'Cycles (max)', right: isNum(fleet?.cyclesMax) ? String(fleet.cyclesMax) : 'n/a' });
    lines.push({ t: 'row', left: 'FETs off chg/dsg', right: `${fleet?.chargeFetOff ?? 0}/${fleet?.dischargeFetOff ?? 0}` });
  }
  lines.push({ t: 'divider' });

  lines.push({ t: 'text', text: 'BATTERIES', bold: true });
  rows.forEach((b, i) => {
    const st = b.stats;
    if (i > 0 && !brief) lines.push({ t: 'blank', n: 1 });
    lines.push({ t: 'text', text: `${i + 1}. ${b.label} - ${b.connected ? 'online' : 'OFFLINE'}`, bold: true });
    if (!isNum(b.voltage) && !isNum(b.current) && !st) {
      lines.push({ t: 'text', text: '- no data -' });
    } else if (brief) {
      // короткий чек: одна-две строки на плату — электрика и заряд
      const facts = [
        num(b.voltage, 2, 'V'), num(b.current, 2, 'A'),
        `SOC ${num(b.soc, 0, '%')}`, st ? `delta ${st.delta} mV` : '',
      ];
      for (const s of packBits(facts, width)) lines.push({ t: 'text', text: s });
    } else {
      // средний чек: три смысловые строки — электрика · заряд и банки · крайние банки
      const groups = [
        [num(b.voltage, 2, 'V'), num(b.current, 1, 'A'), num(b.power, 0, 'W')],
        [`SOC ${num(b.soc, 0, '%')}`, `${b.cellCount || b.cells?.length || 0}S`, st ? `delta ${st.delta} mV` : ''],
        st ? [`min ${volts(st.min)}`, `max ${volts(st.max)}`] : [],
      ];
      for (const g of groups) for (const s of packBits(g, width)) lines.push({ t: 'text', text: s });
    }
    if (full) {
      // полный чек: температуры, циклы, ключи и паспорт платы
      const extra = [
        b.temperatures?.length ? `T ${b.temperatures.map((t) => (isNum(t) ? t.toFixed(1) : 'n/a')).join('/')} C` : '',
        `cycles ${isNum(b.cycles) ? b.cycles : 'n/a'}`,
        `balancing ${b.balancingCells?.length ?? 0}`,
        `chg FET ${onOff(b.chargeFetOn)}`,
        `dsg FET ${onOff(b.dischargeFetOn)}`,
        b.model ? `model ${b.model}` : '',
        b.hwVersion ? `hw ${b.hwVersion}` : '',
        b.swVersion ? `fw ${b.swVersion}` : '',
        b.serial ? `sn ${b.serial}` : '',
        b.prodDate ? `made ${isoDate(b.prodDate)}` : '',
      ];
      for (const s of packBits(extra, width)) lines.push({ t: 'text', text: s });
    }
    const faults = brief ? (b.faults ?? []).slice(0, 2) : (b.faults ?? []);
    for (const f of faults) lines.push({ t: 'text', text: `! ${faultName(f)}` });
  });
  lines.push({ t: 'divider' });
  lines.push({ t: 'text', text: 'Printed by JBD BMS', align: 1 });
  lines.push({ t: 'text', text: fmtTime(Date.now()), align: 1 });
  lines.push({ t: 'feed', n: 4 });
  return lines;
}

function svcError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

export { buildBankReceipt, buildFleetReceipt, buildTestPage, baudSweepLines, PRINTER_BAUDS };
