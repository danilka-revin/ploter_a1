// Сервис управления UART-чековым принтером: конфигурация, подключение,
// форматирование сводки по аккумулятору и печать на ESC/POS-принтер
// (TTL UART, 5–9 В, типично 9600/19200 8N1).
//
// Чеки печатаются на АНГЛИЙСКОМ и только символами ASCII — так их правильно
// печатает любой дешёвый термопринтер, без настройки кодовых страниц
// (см. пояснение в printer.mjs). Подписи банков, имена плат и т. п. из
// данных приводятся к ASCII транслитом.

import { ReceiptPrinter, PRINTER_BAUDS, renderReceiptText, toPrinterText } from './printer.mjs';

/** Допустимая ширина строки чека в символах (58 мм — 32, 80 мм — 48). */
const WIDTH_MIN = 24;
const WIDTH_MAX = 48;

const envBaud = Number(process.env.BMS_PRINTER_BAUD || 9600);
const envWidth = Number(process.env.BMS_PRINTER_WIDTH || 32);
const DEFAULTS = {
  path: process.env.BMS_PRINTER_PORT || '',
  baudRate: PRINTER_BAUDS.includes(envBaud) ? envBaud : 9600,
  width: Number.isInteger(envWidth) && envWidth >= WIDTH_MIN && envWidth <= WIDTH_MAX ? envWidth : 32,
};

export class PrinterService {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.config = { ...DEFAULTS };
    this.printer = null;
    this.lastError = '';
    this.lastPrintAt = 0;
  }

  status() {
    return {
      configured: Boolean(this.config.path),
      path: this.config.path || '',
      baudRate: this.config.baudRate,
      width: this.config.width,
      language: 'en',
      open: Boolean(this.printer?.isOpen),
      lastError: this.lastError,
      lastPrintAt: this.lastPrintAt,
      bauds: PRINTER_BAUDS,
    };
  }

  configure(patch = {}) {
    if (typeof patch.path === 'string') {
      const next = String(patch.path || '').trim();
      if (this.printer && (next !== this.config.path || !next)) {
        // порт меняется — закрываем старый
        this.printer.close().catch(() => {});
        this.printer = null;
      }
      this.config.path = next;
    }
    if (patch.baudRate !== undefined && patch.baudRate !== null) {
      const b = Number(patch.baudRate);
      if (PRINTER_BAUDS.includes(b)) {
        if (b !== this.config.baudRate) {
          if (this.printer) { this.printer.close().catch(() => {}); this.printer = null; }
          this.config.baudRate = b;
        }
      }
    }
    if (patch.width !== undefined) {
      const w = Number(patch.width);
      if (Number.isInteger(w) && w >= WIDTH_MIN && w <= WIDTH_MAX) this.config.width = w;
    }
    this.log(`конфигурация: ${this.config.path || '(не выбран)'} @ ${this.config.baudRate}, ширина ${this.config.width}, чек на английском (ASCII)`);
    return this.status();
  }

  _ensure() {
    if (!this.config.path) throw svcError(400, 'NO_PRINTER', 'Порт принтера не выбран.');
    if (!this.printer || this.printer.path !== this.config.path || this.printer.baudRate !== this.config.baudRate) {
      this.printer = new ReceiptPrinter({
        path: this.config.path,
        baudRate: this.config.baudRate,
        width: this.config.width,
      });
    }
    // ширина могла поменяться после первой печати — порт ради этого не переоткрываем
    this.printer.width = this.config.width;
    return this.printer;
  }

  async testPage() {
    const p = this._ensure();
    try {
      await p.open();
      await p.printLines(buildTestPage({ path: p.path, baudRate: p.baudRate, width: p.width }));
      this.lastError = '';
      this.lastPrintAt = Date.now();
      return { ok: true, at: this.lastPrintAt, path: p.path, baudRate: p.baudRate };
    } catch (e) {
      this.lastError = e.message;
      throw svcError(502, 'PRINT_FAILED', `Принтер не напечатал: ${e.message}`);
    }
  }

  /**
   * Напечатать сводку по одному банку (BMS).
   * @param {object} bankRow      — строка банка из banks.row()
   * @param {object} fleet        — итоги парка (для сводки "всего в парке")
   */
  async printBank(bankRow, fleet = null) {
    const p = this._ensure();
    try {
      await p.open();
      await p.printLines(buildBankReceipt(bankRow, fleet, p.width));
      this.lastError = '';
      this.lastPrintAt = Date.now();
      return { ok: true, at: this.lastPrintAt, bank: bankRow.label, path: p.path };
    } catch (e) {
      this.lastError = e.message;
      throw svcError(502, 'PRINT_FAILED', `Печать сводки не удалась: ${e.message}`);
    }
  }

  /** Напечатать сводку по всем банкам (парку) с компактной таблицей. */
  async printFleet(rows, fleet) {
    const p = this._ensure();
    try {
      await p.open();
      await p.printLines(buildFleetReceipt(rows, fleet, p.width));
      this.lastError = '';
      this.lastPrintAt = Date.now();
      return { ok: true, at: this.lastPrintAt, banks: rows.length, path: p.path };
    } catch (e) {
      this.lastError = e.message;
      throw svcError(502, 'PRINT_FAILED', `Печать сводки по парку не удалась: ${e.message}`);
    }
  }

  // ---------- предпросмотр: тот же чек обычным текстом, без принтера ----------

  previewTest() {
    const width = this.config.width;
    const lines = buildTestPage({ path: this.config.path || '(not selected)', baudRate: this.config.baudRate, width });
    return { kind: 'test', width, lines: renderReceiptText(lines, width) };
  }

  previewBank(bankRow, fleet = null) {
    const width = this.config.width;
    return { kind: 'bank', width, lines: renderReceiptText(buildBankReceipt(bankRow, fleet, width), width) };
  }

  previewFleet(rows, fleet) {
    const width = this.config.width;
    return { kind: 'fleet', width, lines: renderReceiptText(buildFleetReceipt(rows, fleet, width), width) };
  }

  async close() {
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
    { t: 'cut' },
  ];
}

function buildBankReceipt(b, fleet, width = 32) {
  const st = b.stats;
  const T = b.temperatures || [];
  const cells = b.cells || [];
  const lines = [];
  lines.push({ t: 'text', text: 'BATTERY REPORT', align: 1, bold: true, size: 'big' });
  lines.push({ t: 'text', text: b.label, align: 1, bold: true });
  if (b.deviceName && b.deviceName !== b.label) lines.push({ t: 'text', text: b.deviceName, align: 1 });
  if (b.model) lines.push({ t: 'text', text: `Model: ${b.model}`, align: 1 });
  lines.push({ t: 'divider' });

  lines.push({ t: 'row', left: 'Status', right: b.connected ? 'online' : 'OFFLINE' });
  lines.push({ t: 'row', left: 'Updated', right: fmtTime(b.at) });
  lines.push({ t: 'row', left: 'Port', right: b.demo ? 'demo' : b.path });
  lines.push({ t: 'divider' });

  lines.push({ t: 'text', text: 'MAIN READINGS', bold: true });
  lines.push({ t: 'row', left: 'Voltage', right: num(b.voltage, 2, 'V') });
  lines.push({ t: 'row', left: 'Current', right: num(b.current, 2, 'A') });
  lines.push({ t: 'row', left: 'Power', right: num(b.power, 1, 'W') });
  lines.push({ t: 'row', left: 'State of charge', right: num(b.soc, 0, '%') });
  lines.push({ t: 'row', left: 'Remaining', right: ah(b.remainingAh, b.fullAh) });
  lines.push({ t: 'row', left: 'Cycles', right: isNum(b.cycles) ? String(b.cycles) : 'n/a' });
  lines.push({ t: 'row', left: 'Cells in series', right: `${b.cellCount || cells.length}S` });
  lines.push({ t: 'divider' });

  lines.push({ t: 'text', text: 'CELLS', bold: true });
  if (st) {
    lines.push({ t: 'row', left: 'Lowest cell', right: `#${st.minIndex + 1}  ${volts(st.min)}` });
    lines.push({ t: 'row', left: 'Highest cell', right: `#${st.maxIndex + 1}  ${volts(st.max)}` });
    lines.push({ t: 'row', left: 'Average', right: volts(st.avg) });
    lines.push({ t: 'row', left: 'Delta (max-min)', right: num(st.delta, 0, 'mV') });
  } else {
    lines.push({ t: 'text', text: '- no cell data -' });
  }
  if (cells.length) {
    const grid = cellGrid(cells, st, b.balancingCells, width);
    lines.push({ t: 'blank', n: 1 });
    for (const row of grid.rows) lines.push({ t: 'text', text: row });
    for (const row of packBits(grid.legend, width)) lines.push({ t: 'text', text: row });
  }
  lines.push({ t: 'divider' });

  lines.push({ t: 'text', text: 'TEMPERATURES', bold: true });
  if (T.length) {
    T.forEach((t, i) => lines.push({ t: 'row', left: `Sensor T${i + 1}`, right: temp(t) }));
  } else {
    lines.push({ t: 'text', text: '- no sensors -' });
  }
  lines.push({ t: 'divider' });

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
  lines.push({ t: 'divider' });

  if (b.hwVersion || b.swVersion || b.serial || b.prodDate) {
    lines.push({ t: 'text', text: 'BOARD', bold: true });
    if (b.hwVersion) lines.push({ t: 'row', left: 'Hardware', right: b.hwVersion });
    if (b.swVersion) lines.push({ t: 'row', left: 'Firmware', right: b.swVersion });
    if (b.serial) lines.push({ t: 'row', left: 'Serial no.', right: b.serial });
    if (b.prodDate) lines.push({ t: 'row', left: 'Manufactured', right: isoDate(b.prodDate) });
    lines.push({ t: 'divider' });
  }

  if (fleet && fleet.banks > 1) {
    lines.push({ t: 'text', text: `ALL BATTERIES: ${fleet.online}/${fleet.banks} ONLINE`, bold: true, align: 1 });
    lines.push({ t: 'row', left: 'Total current', right: num(fleet.currentSum, 2, 'A') });
    lines.push({ t: 'row', left: 'Total power', right: num(fleet.powerSum, 1, 'W') });
    lines.push({ t: 'row', left: 'Total remaining', right: ah(fleet.ahSum, fleet.ahCapacity, 1) });
    lines.push({ t: 'row', left: 'Max cell delta', right: num(fleet.cellDelta, 0, 'mV') });
    lines.push({ t: 'row', left: 'Max temperature', right: temp(fleet.tempMax) });
    lines.push({ t: 'divider' });
  }

  lines.push({ t: 'text', text: 'Printed by JBD BMS', align: 1 });
  lines.push({ t: 'text', text: fmtTime(Date.now()), align: 1 });
  lines.push({ t: 'cut' });
  return lines;
}

function buildFleetReceipt(rows, fleet, width = 32) {
  const lines = [];
  lines.push({ t: 'text', text: 'ALL BATTERIES', align: 1, bold: true, size: 'big' });
  lines.push({ t: 'text', text: 'Summary report', align: 1, bold: true });
  lines.push({ t: 'divider' });
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
  lines.push({ t: 'divider' });

  lines.push({ t: 'text', text: 'BATTERIES', bold: true });
  rows.forEach((b, i) => {
    const st = b.stats;
    if (i > 0) lines.push({ t: 'blank', n: 1 });
    lines.push({ t: 'text', text: `${b.label} - ${b.connected ? 'online' : 'OFFLINE'}`, bold: true });
    if (!isNum(b.voltage) && !isNum(b.current) && !st) {
      lines.push({ t: 'text', text: '- no data -' });
    } else {
      // три смысловые строки: электрика · заряд и банки · крайние банки
      const groups = [
        [num(b.voltage, 2, 'V'), num(b.current, 1, 'A'), num(b.power, 0, 'W')],
        [`SOC ${num(b.soc, 0, '%')}`, `${b.cellCount || b.cells?.length || 0}S`, st ? `delta ${st.delta} mV` : ''],
        st ? [`min ${volts(st.min)}`, `max ${volts(st.max)}`] : [],
      ];
      for (const g of groups) for (const s of packBits(g, width)) lines.push({ t: 'text', text: s });
    }
    for (const f of b.faults ?? []) lines.push({ t: 'text', text: `! ${faultName(f)}` });
  });
  lines.push({ t: 'divider' });
  lines.push({ t: 'text', text: 'Printed by JBD BMS', align: 1 });
  lines.push({ t: 'text', text: fmtTime(Date.now()), align: 1 });
  lines.push({ t: 'cut' });
  return lines;
}

function svcError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

export { buildBankReceipt, buildFleetReceipt, buildTestPage, PRINTER_BAUDS };
