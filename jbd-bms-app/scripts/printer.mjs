// Мини-принтер чеков по UART TTL (ESC/POS-совместимый).
//
// Большинство дешёвых TTL-термопринтеров с AliExpress (5–9 В, TTL UART,
// 203 dpi, 58 мм бумага) понимают базовые команды ESC/POS и работают на
// скорости 9600 8N1. У некоторых моделей скорость иная (19200 / 115200) —
// она задаётся параметром baudRate.
//
// Чек печатается ТОЛЬКО 7-битным ASCII: английский текст, латиница, цифры.
// Почему не кириллица: у таких принтеров по умолчанию часто включён китайский
// шрифт (GB18030), и любой байт ≥ 0x80 (кириллица в CP866 и т. п.) печатается
// иероглифами; номера кодовых страниц ESC t у разных производителей тоже не
// совпадают. Символы 0x20–0x7E одинаково печатает любой ESC/POS-принтер.
// Поэтому каждая строка проходит через toPrinterText(): кириллица — транслитом,
// типографские знаки (° Δ · — « » № …) — ASCII-заменами, управляющие байты
// вырезаются (чтобы строка из платы не стала командой принтера).
//
// Модуль умеет:
//   • открыть/закрыть порт;
//   • напечатать текст с выравниванием (влево/центр/вправо), жирный и
//     двойной размер (для заголовков);
//   • строку «название … значение» во всю ширину (не влезает — значение
//     переносится на следующую строку, прижатым вправо);
//   • разделитель, пустые строки, штрих-код CODE128, прогон бумаги и отрез
//     (если у модели нет ножа, команда отреза просто игнорируется);
//   • показать чек обычным текстом (renderReceiptText) — для предпросмотра
//     в интерфейсе и для тестов.
//
// Пример:
//   import { ReceiptPrinter } from './printer.mjs';
//   const p = new ReceiptPrinter({ path: '/dev/ttyUSB1', baudRate: 9600 });
//   await p.open();
//   await p.printLines(lines);
//   await p.close();

import { SerialPort } from 'serialport';

const DEFAULT_BAUD = 9600;
const DEFAULT_WIDTH = 32;
/** Задержка между командами: дешёвые принтеры медленно переваривают ESC-команды. */
const CMD_DELAY_MS = 20;
/** Сколько пустых строк подать после печати (вместо отреза, если его нет). */
const FEED_LINES = 4;

// ---------- ESC/POS байтовые константы ----------
const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

// ESC @ — инициализация (сброс выравнивания, шрифта, жирности)
const CMD_INIT = Buffer.from([ESC, 0x40]);
// ESC R 0 — международный набор «США»: стандартные # $ @ [ \ ] ^ { | } ~
const CMD_INTL_USA = Buffer.from([ESC, 0x52, 0x00]);
// ESC t 0 — кодовая страница PC437. Байты ≥ 0x80 мы не шлём вовсе, команда —
// только для предсказуемого состояния принтера.
const CMD_CODEPAGE_PC437 = Buffer.from([ESC, 0x74, 0x00]);
// ESC a n — выравнивание: 0 влево, 1 центр, 2 вправо
const CMD_ALIGN = (n) => Buffer.from([ESC, 0x61, n & 0x03]);
// GS ! n — размер шрифта: 0x00 обычный, 0x10 двойная высота, 0x01 двойная ширина, 0x11 обе
const CMD_SIZE = (n) => Buffer.from([GS, 0x21, n & 0xff]);
// ESC E n — жирный: 0 выкл, 1 вкл
const CMD_BOLD = (n) => Buffer.from([ESC, 0x45, n ? 1 : 0]);
// GS V 66 n — подача к ножу и неполный отрез. Для принтеров без ножа
// это просто подача бумаги — команда безопасно игнорируется.
const CMD_CUT_PART = Buffer.from([GS, 0x56, 0x42, 0x00]);
// ESC d n — подать n строк
const feed = (n) => Buffer.from([ESC, 0x64, Math.max(0, Math.min(255, n))]);

/** GS k 73 n {B data — штрих-код CODE128, набор B (печатный ASCII; «{» экранируется как «{{»). */
function barcode128(text) {
  const data = Buffer.from(`{B${text.replace(/\{/g, '{{')}`, 'ascii');
  return Buffer.concat([Buffer.from([GS, 0x6b, 0x49, data.length]), data]);
}

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
const sizeCode = (size) => (size === 'big' ? 0x11 : size === 'wide' ? 0x01 : size === 'tall' ? 0x10 : 0x00);
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
        if (text) ops.push({ op: 'barcode', text });
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
      const wide = isDoubleWidth(op.size);
      const cols = wide ? op.text.length * 2 : op.text.length;
      const shown = wide ? Array.from(op.text, (c) => `${c} `).join('').trimEnd() : op.text;
      const padLeft = op.align === 1 ? Math.floor((w - cols) / 2) : op.align === 2 ? w - cols : 0;
      out.push((' '.repeat(Math.max(0, padLeft)) + shown).trimEnd());
    } else if (op.op === 'barcode') {
      const label = `[barcode ${op.text}]`;
      out.push(' '.repeat(Math.max(0, Math.floor((w - label.length) / 2))) + label);
    } else if (op.op === 'feed') {
      for (let i = 0; i < op.n; i++) out.push('');
    }
  }
  // хвостовые пустые строки (подача перед отрезом) в предпросмотре не нужны
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

function sleep(ms) { return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(); }

// ========================================================================
// ReceiptPrinter
// ========================================================================

export class ReceiptPrinter {
  /**
   * @param {{path:string, baudRate?:number, width?:number, cmdDelayMs?:number}} opts
   *   path       — последовательный порт принтера (напр. /dev/ttyUSB1, COM4)
   *   baudRate   — скорость UART, по умолчанию 9600
   *   width      — ширина строки в символах (по умолчанию 32 для 58 мм бумаги)
   *   cmdDelayMs — пауза после каждой посылки (медленным принтерам), по умолчанию 20 мс
   */
  constructor({ path, baudRate = DEFAULT_BAUD, width = DEFAULT_WIDTH, cmdDelayMs = CMD_DELAY_MS } = {}) {
    this.path = path;
    this.baudRate = Number(baudRate) || DEFAULT_BAUD;
    this.width = clampWidth(width);
    this.cmdDelayMs = Math.max(0, Number(cmdDelayMs) || 0);
    this.port = null;
    this._busy = null;
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
      port.open((err) => {
        if (err) { reject(new Error(`не удалось открыть принтер ${this.path} @ ${this.baudRate}: ${err.message}`)); return; }
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
    await this.send(CMD_INIT);
    await this.send(Buffer.concat([CMD_INTL_USA, CMD_CODEPAGE_PC437]));
  }
  async align(n) { await this.send(CMD_ALIGN(alignCode(n))); }   // 0=left 1=center 2=right
  async bold(on) { await this.send(CMD_BOLD(on ? 1 : 0)); }
  /** size: 0 обычный, 'big' двойной размер, 'wide' двойная ширина, 'tall' двойная высота */
  async font(size = 0) { await this.send(CMD_SIZE(sizeCode(size))); }

  /** Одна строка текста (любой текст приводится к печатному ASCII). */
  async writeLine(text) {
    await this.send(Buffer.concat([asciiBytes(text), Buffer.from([LF])]));
  }

  async divider(ch = '-') {
    await this.writeLine((toPrinterText(ch).trim()[0] || '-').repeat(this.width));
  }

  async blank(n = 1) {
    for (let i = 0; i < n; i++) await this.writeLine('');
  }

  async cut() {
    await this.feed(FEED_LINES);
    // команда отреза может не поддерживаться — отправляем, не ругаемся, если не сработает
    try { await this.send(CMD_CUT_PART); } catch { /* игнорируем */ }
    await sleep(Math.min(120, this.cmdDelayMs * 6));
  }

  async feed(n) { await this.send(feed(n)); }

  /**
   * Печатает чек: массив команд (см. layoutReceipt). В конце — подача и отрез,
   * если чек сам не закончился командой { t: 'cut' }.
   */
  async printLines(lines) {
    const ops = layoutReceipt(lines, this.width);
    const run = async () => {
      if (!this.isOpen) await this.open();
      await this.init();
      // после ESC @ принтер в состоянии по умолчанию; форматирование шлём только при смене
      const cur = { align: 0, bold: false, size: 0 };
      const style = async (align, bold, size) => {
        if (align !== cur.align) { await this.align(align); cur.align = align; }
        if (bold !== cur.bold) { await this.bold(bold); cur.bold = bold; }
        if (sizeCode(size) !== sizeCode(cur.size)) { await this.font(size); cur.size = size; }
      };
      for (const op of ops) {
        if (op.op === 'line') {
          await style(op.align, op.bold, op.size);
          await this.writeLine(op.text);
        } else if (op.op === 'feed') {
          await this.feed(op.n);
        } else if (op.op === 'barcode') {
          try {
            await style(1, false, 0);
            await this.send(barcode128(op.text));
            await this.feed(2);
          } catch { /* нет штрих-кода — не критично */ }
        } else if (op.op === 'cut') {
          await style(0, false, 0);
          await this.cut();
        }
      }
      await style(0, false, 0);
      if (ops[ops.length - 1]?.op !== 'cut') await this.cut();
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
