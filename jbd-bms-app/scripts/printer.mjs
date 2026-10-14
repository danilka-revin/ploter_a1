// Мини-принтер чеков по UART TTL (ESC/POS-совместимый).
//
// Большинство дешёвых TTL-термопринтеров с AliExpress (5–9 В, TTL UART,
// 203 dpi, 58 мм бумага) понимают базовые команды ESC/POS и работают на
// скорости 9600 8N1. У некоторых моделей скорость иная (19200 / 115200) —
// она задаётся параметром baudRate.
//
// Модуль умеет:
//   • открыть/закрыть порт;
//   • напечатать простой текст с выравниванием (влево/центр/вправо) и
//     двойной/утолщённой шириной (для заголовков);
//   • разделитель (пунктир);
//   • простой штрих-код CODE128 (если модель поддерживает);
//   • прогон бумаги и отрез (полный/неполный) или просто несколько
//     пустых строк после печати, если отрез не поддерживается;
//   • транслитерацию русского текста в CP866-совместимую раскладку —
//     большинство TTL-принтеров содержат знакогенератор CP866 и выводят
//     кириллицу, если включить кодовую страницу 17. Если же ваша модель
//     не имеет кириллицы — установите {ascii: true}, и текст пойдёт
//     транслитом.
//
// Пример:
//   import { ReceiptPrinter } from './printer.mjs';
//   const p = new ReceiptPrinter({ path: '/dev/ttyUSB1', baudRate: 9600 });
//   await p.open();
//   await p.printLines(lines);
//   await p.close();

import { SerialPort } from 'serialport';

const DEFAULT_BAUD = 9600;
/** Задержка между командами: дешёвые принтеры медленно переваривают ESC-команды. */
const CMD_DELAY_MS = 20;
/** Сколько пустых строк подать после печати (вместо отреза, если его нет). */
const FEED_LINES = 4;

// ---------- ESC/POS байтовые константы ----------
const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

// ESC @ — инициализация
const CMD_INIT = Buffer.from([ESC, 0x40]);
// ESC a n — выравнивание: 0 влево, 1 центр, 2 вправо
const CMD_ALIGN = (n) => Buffer.from([ESC, 0x61, n & 0x03]);
// GS ! n — размер шрифта: 0x00 обычный, 0x10 двойная высота, 0x01 двойная ширина, 0x11 обе
const CMD_SIZE = (n) => Buffer.from([GS, 0x21, n & 0xff]);
// ESC E n — жирный: 0 выкл, 1 вкл
const CMD_BOLD = (n) => Buffer.from([ESC, 0x45, n ? 1 : 0]);
// ESC t n — выбор таблицы символов: 17 = CP866 (кириллица DOS), 2 = PC850 (латиница)
const CMD_CHARSET = (n) => Buffer.from([ESC, 0x74, n & 0xff]);
// GS V n — отрез (0x41 полный, 0x42 неполный, с подачей). Для принтеров без ножа
// это просто подача бумаги — команда безопасно игнорируется.
const CMD_CUT_FULL = Buffer.from([GS, 0x56, 0x41, 0x00]);
const CMD_CUT_PART = Buffer.from([GS, 0x56, 0x42, 0x00]);
// ESC d n — подать n строк
const feed = (n) => Buffer.from([ESC, 0x64, Math.max(0, Math.min(255, n))]);
// GS k m d1...dk 0 — штрих-код CODE128 (m=73 для CODE128 в новых моделях).
// Чтобы не усложнять — отправляем простой вариант CODE128 B с завершающим NUL.

/**
 * @param {string} text
 */
function barcode128(text) {
  const data = Buffer.from(text, 'ascii');
  // CODE128 B: старт-символ 0x42, потом ASCII-символы + 32, потом контрольная сумма
  const out = [GS, 0x6b, 0x49, data.length];
  for (let i = 0; i < data.length; i++) out.push(data[i]);
  return Buffer.from(out);
}

// ---------- транслит кириллицы (на случай если у принтера нет CP866) ----------
const RU_TR = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y',
  'к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f',
  'х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'sch','ъ':'\'','ы':'y','ь':'\'','э':'e','ю':'yu','я':'ya',
};
function translitRu(s) {
  return s.split('').map((ch) => {
    const lower = ch.toLowerCase();
    const tr = RU_TR[lower];
    if (!tr) return ch;
    return ch === lower ? tr : tr[0].toUpperCase() + tr.slice(1);
  }).join('');
}

/**
 * Переводит строку UTF-8 в буфер байтов в кодировке CP866 (DOS Cyrillic).
 * Символы вне CP866 заменяются на '?'.
 */
function toCp866(str) {
  const bytes = [];
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) { bytes.push(code); continue; }
    // Ё ё
    if (code === 0x0401) { bytes.push(0xf0); continue; }
    if (code === 0x0451) { bytes.push(0xf1); continue; }
    // А-Я (U+0410..U+042F) → 0x80..0x9F
    if (code >= 0x0410 && code <= 0x042f) { bytes.push(0x80 + (code - 0x0410)); continue; }
    // а-п (U+0430..U+043F) → 0xA0..0xAF  (в CP866 р начинается с 0xE0? Уточним классическую таблицу)
    if (code >= 0x0430 && code <= 0x043f) { bytes.push(0xa0 + (code - 0x0430)); continue; }
    // р-я (U+0440..U+044F) → 0xE0..0xEF
    if (code >= 0x0440 && code <= 0x044f) { bytes.push(0xe0 + (code - 0x0440)); continue; }
    // №
    if (code === 0x2116) { bytes.push(0xd9); continue; }
    // « » — кавычки-ёлочки
    if (code === 0x00ab) { bytes.push(0xae); continue; }
    if (code === 0x00bb) { bytes.push(0xaf); continue; }
    bytes.push(0x3f); // '?'
  }
  return Buffer.from(bytes);
}

/** Подготовка строки для вывода: \n уже внутри превращаем в LF; перевод табов в пробелы. */
function lineToBuf(line, opts) {
  const text = String(line ?? '').replace(/\t/g, '    ');
  if (opts?.ascii) return Buffer.from(translitRu(text), 'ascii');
  return toCp866(text);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ========================================================================
// ReceiptPrinter
// ========================================================================

export class ReceiptPrinter {
  /**
   * @param {{path:string, baudRate?:number, ascii?:boolean, charPage?:number, width?:number}} opts
   *   path       — последовательный порт принтера (напр. /dev/ttyUSB1)
   *   baudRate   — скорость UART, по умолчанию 9600
   *   ascii      — true, если у принтера нет кириллицы (печатаем транслитом)
   *   charPage   — кодовая страница ESC t, по умолчанию 17 (CP866)
   *   width      — ширина строки в символах (по умолчанию 32 для 58 мм бумаги)
   */
  constructor({ path, baudRate = DEFAULT_BAUD, ascii = false, charPage = 17, width = 32 } = {}) {
    this.path = path;
    this.baudRate = Number(baudRate) || DEFAULT_BAUD;
    this.ascii = Boolean(ascii);
    this.charPage = charPage;
    this.width = Number(width) || 32;
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
    await sleep(CMD_DELAY_MS);
  }

  // ---------- примитивы ----------

  async init() { await this.send(CMD_INIT); await this.send(CMD_CHARSET(this.ascii ? 2 : this.charPage)); }
  async align(n) { await this.send(CMD_ALIGN(n)); }       // 0=left 1=center 2=right
  async bold(on) { await this.send(CMD_BOLD(on ? 1 : 0)); }
  /** size: 0 обычный, 'big' двойной размер, 'wide' двойная ширина, 'tall' двойная высота */
  async font(size = 0) {
    const n = size === 'big' ? 0x11 : size === 'wide' ? 0x01 : size === 'tall' ? 0x10 : 0x00;
    await this.send(CMD_SIZE(n));
  }

  async writeLine(text, opts = {}) {
    await this.send(Buffer.concat([lineToBuf(text, { ascii: this.ascii }), Buffer.from([LF])]));
  }

  async divider(ch = '-') {
    await this.writeLine((ch[0] || '-').repeat(this.width));
  }

  async blank(n = 1) {
    for (let i = 0; i < n; i++) await this.writeLine('');
  }

  async cut() {
    await this.feed(FEED_LINES);
    // команда отреза может не поддерживаться — отправляем, не ругаемся, если не сработает
    try { await this.send(CMD_CUT_PART); } catch { /* игнорируем */ }
    await sleep(120);
  }

  async feed(n) { await this.send(feed(n)); }

  /**
   * Печатает последовательность команд (массив объектов) на чек.
   * Поддерживаемые команды:
   *   { t: 'text', text, align?, bold?, size? }
   *   { t: 'row', left, right }        — таблица из двух колонок (key/value)
   *   { t: 'divider', ch? }            — разделитель
   *   { t: 'blank', n? }
   *   { t: 'barcode', text }           — CODE128
   *   { t: 'cut' }
   *   { t: 'feed', n }
   */
  async printLines(lines) {
    if (!this.isOpen) await this.open();
    // сериализуем вызовы, чтобы медленный принтер не потерял байты
    const busy = (this._busy || Promise.resolve()).then(async () => {
      await this.init();
      await this.align(0);
      await this.bold(false);
      await this.font(0);
      for (const ln of lines) {
        switch (ln?.t) {
          case 'text': {
            if (ln.align !== undefined) await this.align(ln.align);
            await this.bold(Boolean(ln.bold));
            await this.font(ln.size || 0);
            for (const part of splitLines(String(ln.text ?? ''), this.width * (ln.size === 'big' || ln.size === 'wide' ? 1 : 1))) {
              await this.writeLine(part);
            }
            // сброс к дефолту после каждой строки с форматированием
            await this.font(0);
            await this.bold(false);
            await this.align(0);
            break;
          }
          case 'row': {
            await this.align(0);
            await this.bold(Boolean(ln.bold));
            const k = String(ln.left ?? '');
            const v = String(ln.right ?? '');
            const pad = Math.max(1, this.width - realLen(k) - realLen(v));
            await this.writeLine(k + ' '.repeat(pad) + v);
            await this.bold(false);
            break;
          }
          case 'divider': await this.divider(ln.ch); break;
          case 'blank': await this.blank(ln.n ?? 1); break;
          case 'feed': await this.feed(Math.max(1, Number(ln.n) || 1)); break;
          case 'barcode':
            try {
              await this.align(1);
              await this.send(barcode128(String(ln.text).slice(0, 20).replace(/[^\x20-\x7e]/g, '')));
              await this.feed(2);
              await this.align(0);
            } catch { /* нет штрих-кода — не критично */ }
            break;
          case 'cut': await this.cut(); break;
          default:
            if (typeof ln === 'string') await this.writeLine(ln);
        }
      }
      await this.cut();
    }).catch((e) => { throw e; });
    this._busy = busy.catch(() => {});
    return busy;
  }
}

/** Длина строки с учётом宽их символов СР866 (кириллица и латиница там одной ширины). */
function realLen(s) {
  // Упрощённо: все печатные — одна позиция; двойная ширина включается командой size=wide.
  return Array.from(String(s)).length;
}

/** Наивный перенос длинных строк по ширине (по пробелам). */
function splitLines(text, width) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (realLen(raw) <= width) { out.push(raw); continue; }
    // разбиваем по пробелам
    const words = raw.split(/(\s+)/);
    let cur = '';
    for (const w of words) {
      if (realLen(cur + w) > width && cur.trim()) { out.push(cur.trimEnd()); cur = w.trimStart(); }
      else cur += w;
      if (realLen(cur) > width) {
        // слово длиннее ширины — режем жёстко
        while (realLen(cur) > width) {
          out.push(cur.slice(0, width));
          cur = cur.slice(width);
        }
      }
    }
    if (cur) out.push(cur);
  }
  return out.length ? out : [''];
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
