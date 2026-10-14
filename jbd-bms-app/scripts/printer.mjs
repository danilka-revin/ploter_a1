// UART-драйвер: plain (без команд), ESC/POS и AlexGyver/Printer:
// https://github.com/AlexGyver/Printer/blob/f218472ce97d1789e15e9707345d5d9192245598/libraries/printer/printer.h
// Перенос протокола в Node.js: Arduino/ESP и сторонняя прошивка не нужны.
// Только профиль alexgyver: begin(): FF, пауза 60 мс, ESC @; config(): ESC 7; font(): ESC !.
// Нагрев 10/140/4 взят из WemosPrint. Выравнивание — пробелами,
// подача — CR LF (Arduino Print.println), без команд ножа/штрих-кода.
// Текст — ASCII: кириллица транслитом, управляющие байты удаляются.
// Байты >= 0x80 — только служебные: wake FF и время нагрева 140.
// Порт принтера должен быть исключён из опроса BMS (см. server.mjs).

import { SerialPort } from 'serialport';

const DEFAULT_BAUD = 9600;
const DEFAULT_WIDTH = 32;
/** Задержка между командами: дешёвые принтеры медленно переваривают ESC-команды. */
const CMD_DELAY_MS = 20;
/** Сколько пустых строк подать после печати для ручного отрыва. */
const FEED_LINES = 4;

// ---------- команды из libraries/printer/printer.h ----------
const ESC = 0x1b;
const CMD_WAKE = Buffer.from([0xff]);
const CMD_INIT = Buffer.from([ESC, 0x40]);
const CMD_CONFIG = Buffer.from([ESC, 0x37, 10, 140, 4]);
const CMD_CODEPAGE_PC437 = Buffer.from([ESC, 0x74, 0x00]);
const CMD_FONT = (mode) => Buffer.from([ESC, 0x21, mode]);
const CRLF = Buffer.from([0x0d, 0x0a]);
const FONT_EMPH = 1 << 3;
const FONT_DOUBLE_H = 1 << 4;
const FONT_DOUBLE_W = 1 << 5;

// ---------- перевод любого текста в печатный ASCII ----------

/** Транслит кириллицы (русский + украинские/белорусские буквы) латиницей. */
const CYR = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y',
  'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f',
  'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
  'є': 'ye', 'і': 'i', 'ї': 'yi', 'ґ': 'g', 'ў': 'u',
};

/** Типографские и технические знаки, которых нет в ASCII. */
const SYMBOLS = {
  '\u00a0': ' ', '\u2002': ' ', '\u2003': ' ', '\u2007': ' ', '\u2009': ' ', '\u200a': ' ', '\u202f': ' ',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  '\u00b7': '-', '\u2022': '*', '\u2026': '...',
  '\u00ab': '"', '\u00bb': '"', '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u2018': "'", '\u2019': "'", '\u201a': "'",
  '\u00b0': 'deg', '\u2103': 'C', '\u2116': 'No.', '\u00d7': 'x', '\u00f7': '/', '\u00b1': '+/-', '\u2248': '~',
  '\u2264': '<=', '\u2265': '>=', '\u2260': '!=', '\u2192': '->', '\u2190': '<-', '\u2191': '^', '\u2193': 'v',
  '\u00b5': 'u', '\u03bc': 'u', '\u0394': 'd', '\u03b4': 'd', '\u03a9': 'Ohm', '\u2126': 'Ohm',
  '\u26a0': '!', '\u2713': 'v', '\u2714': 'v', '\u2717': 'x', '\u2718': 'x', '\u00a9': '(c)', '\u00ae': '(R)',
  '\u20ac': 'EUR', '\u20bd': 'RUB', '\u00a3': 'GBP', '\u00df': 'ss', '\u00e6': 'ae', '\u00c6': 'AE',
  '\u00f8': 'o', '\u00d8': 'O', '\u0142': 'l', '\u0141': 'L', '\u0111': 'd', '\u0110': 'D',
};

const isLetter = (c) => Boolean(c) && c.toLowerCase() !== c.toUpperCase();
const isUpper = (c) => isLetter(c) && c === c.toUpperCase();

/**
 * Любая строка → только печатный ASCII (0x20–0x7E).
 * Кириллица — транслитом («Банк 1» → «Bank 1», «ДЕМО» → «DEMO»), знаки
 * вроде ° Δ · — № — ASCII-заменами, буквы с диакритикой — без неё,
 * управляющие символы вырезаются, всё остальное — «?».
 */
export function toPrinterText(input) {
  const chars = Array.from(String(input ?? '').normalize('NFC'));
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code < 0x7f) { out += ch; continue; }
    if (ch === '\t') { out += ' '; continue; }
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue; // управляющие — выкидываем
    const lower = ch.toLowerCase();
    const tr = CYR[lower];
    if (tr !== undefined) {
      if (ch === lower || !tr) { out += tr; continue; }
      // «Щука» → «Shchuka», «ЩУКА» → «SHCHUKA»
      const wholeWordUpper = isUpper(chars[i + 1]) || (!isLetter(chars[i + 1]) && isUpper(chars[i - 1]));
      out += wholeWordUpper ? tr.toUpperCase() : tr[0].toUpperCase() + tr.slice(1);
      continue;
    }
    if (SYMBOLS[ch] !== undefined) { out += SYMBOLS[ch]; continue; }
    const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (base && /^[\x20-\x7e]+$/.test(base)) { out += base; continue; }
    out += '?';
  }
  return out;
}

/** Строка → байты для принтера (гарантированно < 0x80). */
function asciiBytes(text) {
  return Buffer.from(toPrinterText(text), 'ascii');
}

// ---------- раскладка чека по строкам ----------

const clampWidth = (w) => {
  const n = Math.round(Number(w));
  return Number.isFinite(n) && n >= 16 ? Math.min(n, 64) : DEFAULT_WIDTH;
};
const isDoubleWidth = (size) => size === 'big' || size === 'wide';
const sizeCode = (size) => (size === 'big' ? FONT_DOUBLE_H | FONT_DOUBLE_W
  : size === 'wide' ? FONT_DOUBLE_W : size === 'tall' ? FONT_DOUBLE_H : 0);

// Пробел тоже удваивается при FONT_DOUBLE_W: выравниваем в колонках шрифта.
function alignedText(text, align, size, width) {
  const cols = isDoubleWidth(size) ? Math.floor(width / 2) : width;
  const gap = Math.max(0, cols - text.length);
  const pad = align === 1 ? Math.floor(gap / 2) : align === 2 ? gap : 0;
  return ' '.repeat(pad) + text;
}
const alignCode = (a) => (a === 1 || a === 2 ? a : 0);

/** Перенос строки по ширине: по пробелам, слишком длинные слова — жёстко. */
function splitLines(text, width) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.length <= width) { out.push(raw); continue; }
    let cur = '';
    for (const word of raw.split(/(\s+)/)) {
      if (!word) continue;
      if ((cur + word).length > width && cur.trim()) { out.push(cur.trimEnd()); cur = word.trimStart(); }
      else cur += word;
      while (cur.length > width) { out.push(cur.slice(0, width)); cur = cur.slice(width); }
    }
    if (cur.trim() || !out.length) out.push(cur.trimEnd());
  }
  return out.length ? out : [''];
}

const lineOp = (text, { align = 0, bold = false, size = 0 } = {}) => ({ op: 'line', text, align, bold, size });

/**
 * Раскладка чека: команды верхнего уровня
 *   { t: 'text', text, align?, bold?, size? }  — абзац (size: 'big' | 'wide' | 'tall')
 *   { t: 'row', left, right, bold? }           — «название … значение» во всю ширину
 *   { t: 'divider', ch? } · { t: 'blank', n? } · { t: 'feed', n } · { t: 'barcode', text } · { t: 'cut' }
 * превращаются в плоский список операций печати. Каждая строка — уже ASCII
 * и не длиннее ширины бумаги (для двойной ширины — половины).
 */
export function layoutReceipt(lines, width = DEFAULT_WIDTH) {
  const w = clampWidth(width);
  const ops = [];
  for (const ln of lines ?? []) {
    if (typeof ln === 'string') {
      for (const part of splitLines(toPrinterText(ln), w)) ops.push(lineOp(part));
      continue;
    }
    switch (ln?.t) {
      case 'text': {
        const size = ln.size || 0;
        const align = alignCode(ln.align);
        const cols = isDoubleWidth(size) ? Math.max(1, Math.floor(w / 2)) : w;
        for (const part of splitLines(toPrinterText(ln.text), cols)) {
          ops.push(lineOp(align ? part.trim() : part, { align, bold: Boolean(ln.bold), size }));
        }
        break;
      }
      case 'row': {
        const k = toPrinterText(ln.left).trim();
        const v = toPrinterText(ln.right).trim();
        const style = { bold: Boolean(ln.bold) };
        if (k.length + 1 + v.length <= w) {
          ops.push(lineOp(k + ' '.repeat(w - k.length - v.length) + v, style));
        } else {
          for (const part of splitLines(k, w)) ops.push(lineOp(part, style));
          for (const part of splitLines(v, w)) ops.push(lineOp(part.trim().padStart(w), style));
        }
        break;
      }
      case 'divider': {
        const ch = toPrinterText(ln.ch || '-').trim()[0] || '-';
        ops.push(lineOp(ch.repeat(w)));
        break;
      }
      case 'blank':
        for (let i = 0; i < Math.max(0, Number(ln.n ?? 1) || 0); i++) ops.push(lineOp(''));
        break;
      case 'feed': ops.push({ op: 'feed', n: Math.max(1, Number(ln.n) || 1) }); break;
      case 'barcode': {
        const text = toPrinterText(ln.text).slice(0, 20);
        // В драйвере AlexGyver нет штрих-кодов: безопасный текстовый ярлык.
        if (text) for (const part of splitLines(`[barcode ${text}]`, w)) ops.push(lineOp(part, { align: 1 }));
        break;
      }
      case 'cut': ops.push({ op: 'cut' }); break;
      default: break;
    }
  }
  return ops;
}

/**
 * Чек обычным текстом — ровно те символы, что лягут на бумагу. Двойная
 * ширина показана буквами через пробел (каждая занимает две колонки).
 * Нужен для предпросмотра в интерфейсе и для тестов.
 */
export function renderReceiptText(lines, width = DEFAULT_WIDTH) {
  const w = clampWidth(width);
  const out = [];
  for (const op of layoutReceipt(lines, w)) {
    if (op.op === 'line') {
      const text = alignedText(op.text, op.align, op.size, w);
      const shown = isDoubleWidth(op.size) ? Array.from(text, (c) => `${c} `).join('') : text;
      out.push(shown.trimEnd());
    } else if (op.op === 'feed') {
      for (let i = 0; i < op.n; i++) out.push('');
    }
  }
  // хвостовые пустые строки (подача для ручного отрыва) в предпросмотре не нужны
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

function sleep(ms) { return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(); }

// ========================================================================
// ReceiptPrinter
// ========================================================================

export class ReceiptPrinter {
  /**
   * @param {{path:string, baudRate?:number, width?:number, cmdDelayMs?:number, profile?:string, lineDelayMs?:number}} opts
   *   path       — последовательный порт принтера (напр. /dev/ttyUSB1, COM4)
   *   baudRate   — скорость UART, по умолчанию 9600
   *   width      — ширина строки в символах (по умолчанию 32 для 58 мм бумаги)
   *   cmdDelayMs — пауза после каждой посылки (медленным принтерам), по умолчанию 20 мс
   */
  constructor({ path, baudRate = DEFAULT_BAUD, width = DEFAULT_WIDTH, cmdDelayMs = CMD_DELAY_MS, profile = 'alexgyver', lineDelayMs = 0 } = {}) {
    this.path = path;
    this.baudRate = Number(baudRate) || DEFAULT_BAUD;
    this.width = clampWidth(width);
    this.cmdDelayMs = Math.max(0, Number(cmdDelayMs) || 0);
    this.profile = PRINTER_PROFILES.includes(profile) ? profile : 'plain';
    this.lineDelayMs = Math.max(0, Number(lineDelayMs) || 0);
    this.port = null;
    this._portError = null;
    this._busy = null;
    this._style = { align: 0, bold: false, size: 0 };
  }

  get isOpen() { return Boolean(this.port?.isOpen); }

  open() {
    if (this.isOpen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const port = new SerialPort({
        path: this.path,
        baudRate: this.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        rtscts: false,
        xon: false,
        xoff: false,
        autoOpen: false,
      });
      port.on('error', (err) => { this._portError = err; });
      port.open((err) => {
        if (err) { reject(new Error(`не удалось открыть принтер ${this.path} @ ${this.baudRate}: ${err.message}`)); return; }
        this._portError = null;
        this.port = port;
        resolve();
      });
    });
  }

  async close() {
    if (!this.port) return;
    const p = this.port;
    this.port = null;
    await new Promise((res) => {
      if (!p.isOpen) { res(); return; }
      p.close(() => res());
    });
  }

  /** Отправить буфер с ожиданием, чтобы принтер успел принять. */
  async send(buf) {
    if (this._portError) throw this._portError;
    if (!this.isOpen) throw new Error('Принтер не подключён.');
    await new Promise((resolve, reject) => {
      this.port.write(buf, (e) => {
        if (e) { reject(e); return; }
        this.port.drain((de) => (de ? reject(de) : resolve()));
      });
    });
    await sleep(this.cmdDelayMs);
  }

  // ---------- примитивы ----------

  async init() {
    this._style = { align: 0, bold: false, size: 0 };
    if (this.profile === 'plain') return;
    if (this.profile === 'alexgyver') {
      await this.send(CMD_WAKE);
      await sleep(60);
    }
    await this.send(CMD_INIT);
    this._style = { align: 0, bold: false, size: 0 };
    if (this.profile === 'alexgyver') await this.send(CMD_CONFIG);
    await this.send(CMD_CODEPAGE_PC437);
  }

  // В printer.h нет ESC a: добавляем пробелы при отправке строки.
  async align(n) { this._style.align = alignCode(n); }
  async bold(on) { await this.font(this._style.size, Boolean(on)); }
  /** ESC ! объединяет жирность и размер в одной битовой маске. */
  async font(size = 0, bold = this._style.bold) {
    const mode = sizeCode(size) | (bold ? FONT_EMPH : 0);
    const prev = sizeCode(this._style.size) | (this._style.bold ? FONT_EMPH : 0);
    if (this.profile !== 'plain' && mode !== prev) await this.send(CMD_FONT(mode));
    this._style.size = size;
    this._style.bold = bold;
  }

  /** Arduino Print.println(): ASCII-текст и CR LF. */
  async writeLine(text) {
    const line = alignedText(toPrinterText(text), this._style.align, this._style.size, this.width);
    await this.send(Buffer.concat([asciiBytes(line), CRLF]));
    // drain() ждёт UART, а не механизм печати. Без DTR выдерживаем паузу.
    await sleep(this.lineDelayMs * (this._style.size === 'big' || this._style.size === 'tall' ? 2 : 1));
  }

  async divider(ch = '-') {
    await this.writeLine((toPrinterText(ch).trim()[0] || '-').repeat(this.width));
  }

  async blank(n = 1) { await this.feed(n); }

  /** Совместимость со старым { t: 'cut' }: только подача, ножа в printer.h нет. */
  async cut() { await this.feed(FEED_LINES); }

  async feed(n) {
    const count = Math.max(0, Math.min(255, Math.floor(Number(n) || 0)));
    for (let i = 0; i < count; i++) { await this.send(CRLF); await sleep(this.lineDelayMs); }
  }

  /**
   * Печатает чек: массив команд (см. layoutReceipt). В конце — подача бумаги,
   * если чек сам не закончился командой feed/cut.
   */
  async printLines(lines) {
    const ops = layoutReceipt(this.profile === 'plain' ? plainReceipt(lines) : lines, this.width);
    const run = async () => {
      if (!this.isOpen) await this.open();
      await this.init();
      const style = async (align, bold, size) => {
        await this.align(align);
        await this.font(size, bold);
      };
      for (const op of ops) {
        if (op.op === 'line') {
          await style(op.align, op.bold, op.size);
          await this.writeLine(op.text);
        } else if (op.op === 'feed') {
          await style(0, false, 0);
          await this.feed(op.n);
        } else if (op.op === 'cut') {
          await style(0, false, 0);
          await this.cut();
        }
      }
      await style(0, false, 0);
      if (!['cut', 'feed'].includes(ops[ops.length - 1]?.op)) await this.feed(FEED_LINES);
    };
    // сериализуем вызовы, чтобы медленный принтер не потерял байты
    const busy = (this._busy || Promise.resolve()).then(run);
    this._busy = busy.catch(() => {});
    return busy;
  }
}

/** Стандартные скорости для подбора в UI. */
export const PRINTER_BAUDS = [9600, 19200, 38400, 57600, 115200];

/** Список «подозрительных» VID/PID, которые обычно являются USB-UART адаптерами,
 *  а не BMS-портами (только для подсказки — не жёстко). */
export function isPrinterLikePort(p) {
  if (!p) return false;
  const text = `${p.path} ${p.manufacturer || ''} ${p.vendorId || ''} ${p.productId || ''} ${p.label || ''}`.toLowerCase();
  // любые USB-UART можно использовать, это просто подсказка — нет строгого фильтра
  return /ttyusb|ttyacm|cu\./i.test(text);
}

export const PRINTER_PROFILES = ['plain', 'escpos', 'alexgyver'];

export function plainReceipt(lines) {
  return (lines ?? []).map((ln) => ln?.t === 'text' ? { ...ln, size: 0, bold: false } : ln);
}
