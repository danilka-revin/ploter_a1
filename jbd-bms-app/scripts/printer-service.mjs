// Сервис управления UART-чековым принтером: конфигурация, подключение,
// форматирование сводки по аккумулятору и печать на ESC/POS-принтер
// (TTL UART, 5–9 В, типично 9600/19200 8N1).

import { ReceiptPrinter, PRINTER_BAUDS } from './printer.mjs';

const DEFAULTS = {
  path: process.env.BMS_PRINTER_PORT || '',
  baudRate: Number(process.env.BMS_PRINTER_BAUD || 9600),
  ascii: /^(1|true|yes)$/i.test(process.env.BMS_PRINTER_ASCII || ''),
  charPage: Number(process.env.BMS_PRINTER_CHARPAGE || 17),
  width: Number(process.env.BMS_PRINTER_WIDTH || 32),
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
      ascii: this.config.ascii,
      charPage: this.config.charPage,
      width: this.config.width,
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
    if (typeof patch.ascii === 'boolean') this.config.ascii = patch.ascii;
    if (patch.charPage !== undefined) {
      const c = Number(patch.charPage);
      if (Number.isInteger(c) && c >= 0 && c <= 255) this.config.charPage = c;
    }
    if (patch.width !== undefined) {
      const w = Number(patch.width);
      if (Number.isInteger(w) && w >= 24 && w <= 48) this.config.width = w;
    }
    this.log(`принтер: конфигурация: ${this.config.path || '(не выбран)'} @ ${this.config.baudRate}, cp=${this.config.charPage}, ascii=${this.config.ascii}`);
    return this.status();
  }

  _ensure() {
    if (!this.config.path) throw svcError(400, 'NO_PRINTER', 'Порт принтера не выбран.');
    if (!this.printer || this.printer.path !== this.config.path || this.printer.baudRate !== this.config.baudRate) {
      this.printer = new ReceiptPrinter({
        path: this.config.path,
        baudRate: this.config.baudRate,
        ascii: this.config.ascii,
        charPage: this.config.charPage,
        width: this.config.width,
      });
    }
    return this.printer;
  }

  async testPage() {
    const p = this._ensure();
    try {
      await p.open();
      await p.printLines([
        { t: 'text', text: 'JBD BMS', align: 1, bold: true, size: 'big' },
        { t: 'text', text: 'Проверка принтера', align: 1, bold: true },
        { t: 'divider' },
        { t: 'row', left: 'Порт', right: p.path },
        { t: 'row', left: 'Скорость', right: `${p.baudRate} бод` },
        { t: 'row', left: 'Кириллица', right: p.ascii ? 'транслит' : 'CP866' },
        { t: 'row', left: 'Ширина', right: `${p.width} симв.` },
        { t: 'text', text: 'Если вы видите этот текст — принтер работает.' },
        { t: 'text', text: 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ абвгдеёжзийклмнопрстуфхцчшщъыьэюя', align: 0 },
        { t: 'blank', n: 1 },
        { t: 'text', text: new Date().toLocaleString('ru-RU'), align: 1 },
        { t: 'cut' },
      ]);
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
      const lines = buildBankReceipt(bankRow, fleet, p.width);
      await p.printLines(lines);
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
      const lines = buildFleetReceipt(rows, fleet, p.width);
      await p.printLines(lines);
      this.lastError = '';
      this.lastPrintAt = Date.now();
      return { ok: true, at: this.lastPrintAt, banks: rows.length, path: p.path };
    } catch (e) {
      this.lastError = e.message;
      throw svcError(502, 'PRINT_FAILED', `Печать сводки по парку не удалась: ${e.message}`);
    }
  }

  async close() {
    if (this.printer) await this.printer.close().catch(() => {});
    this.printer = null;
  }
}

// ---------- форматирование чека ----------

const pad = (n) => (n < 10 ? `0${n}` : String(n));
const fmtTime = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const n = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : String(v.toFixed(d)).replace('.', ','));
const mv = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : String(Math.round(v)));

function buildBankReceipt(b, fleet, width) {
  const st = b.stats;
  const T = b.temperatures || [];
  const cells = b.cells || [];
  const lines = [];
  lines.push({ t: 'text', text: 'СВОДКА ПО АККУМУЛЯТОРУ', align: 1, bold: true, size: 'big' });
  lines.push({ t: 'text', text: b.label, align: 1, bold: true });
  if (b.deviceName) lines.push({ t: 'text', text: b.deviceName, align: 1 });
  if (b.model) lines.push({ t: 'text', text: `Модель: ${b.model}`, align: 1 });
  lines.push({ t: 'divider' });

  lines.push({ t: 'row', left: 'Статус', right: b.connected ? 'онлайн' : 'нет связи' });
  lines.push({ t: 'row', left: 'Обновлено', right: fmtTime(b.at) });
  lines.push({ t: 'row', left: 'Порт', right: b.demo ? 'демо' : b.path });
  lines.push({ t: 'divider' });

  lines.push({ t: 'text', text: 'ОСНОВНЫЕ ПОКАЗАТЕЛИ', bold: true, align: 0 });
  lines.push({ t: 'row', left: 'Напряжение', right: `${n(b.voltage, 2)} В` });
  lines.push({ t: 'row', left: 'Ток', right: `${n(b.current, 2)} А` });
  lines.push({ t: 'row', left: 'Мощность', right: `${n(b.power, 1)} Вт` });
  lines.push({ t: 'row', left: 'Заряд SOC', right: `${n(b.soc, 0)} %` });
  lines.push({ t: 'row', left: 'Остаток', right: `${n(b.remainingAh, 2)} / ${n(b.fullAh, 2)} Ач` });
  lines.push({ t: 'row', left: 'Циклов', right: b.cycles === null || b.cycles === undefined ? '—' : String(b.cycles) });
  lines.push({ t: 'row', left: 'Ячеек (S)', right: String(b.cellCount || cells.length) });
  lines.push({ t: 'divider' });

  lines.push({ t: 'text', text: 'БАНКИ (ячейки)', bold: true });
  if (st) {
    lines.push({ t: 'row', left: 'Мин банка', right: `#${st.minIndex + 1} · ${(st.min / 1000).toFixed(3).replace('.', ',')} В` });
    lines.push({ t: 'row', left: 'Макс банка', right: `#${st.maxIndex + 1} · ${(st.max / 1000).toFixed(3).replace('.', ',')} В` });
    lines.push({ t: 'row', left: 'Средняя', right: `${(st.avg / 1000).toFixed(3).replace('.', ',')} В` });
    lines.push({ t: 'row', left: 'Разброс Δ', right: `${st.delta} мВ` });
  } else {
    lines.push({ t: 'text', text: '— нет данных по банкам —' });
  }

  // Список банок в компактных колонках. Для 32 симв. умещаем по 2 в строке: "#01 3320мВ".
  if (cells.length) {
    lines.push({ t: 'blank', n: 1 });
    const perRow = width >= 42 ? 3 : 2;
    const colW = Math.floor(width / perRow);
    for (let i = 0; i < cells.length; i += perRow) {
      let s = '';
      for (let j = 0; j < perRow && i + j < cells.length; j++) {
        const idx = i + j;
        const v = cells[idx];
        let cell = `#${pad(idx + 1)} ${mv(v)}мВ`;
        // метки
        if (st) {
          if (idx === st.minIndex) cell += '!';
          else if (idx === st.maxIndex) cell += '^';
        }
        if (b.balancingCells?.includes(idx + 1)) cell += 'b';
        if (j < perRow - 1 && idx + 1 < cells.length) cell = cell.padEnd(colW, ' ');
        s += cell;
      }
      lines.push({ t: 'text', text: s });
    }
    if (st && st.delta > 0) {
      lines.push({ t: 'text', text: `! — мин · ^ — макс · b — баланс`, align: 0 });
    }
  }
  lines.push({ t: 'divider' });

  lines.push({ t: 'text', text: 'ТЕМПЕРАТУРЫ', bold: true });
  if (T.length) {
    T.forEach((t, i) => {
      lines.push({ t: 'row', left: `Датчик T${i + 1}`, right: `${n(t, 1)} °C` });
    });
  } else {
    lines.push({ t: 'text', text: '— датчиков нет —' });
  }
  lines.push({ t: 'divider' });

  lines.push({ t: 'text', text: 'КЛЮЧИ И ЗАЩИТЫ', bold: true });
  lines.push({ t: 'row', left: 'Заряд', right: b.chargeFetOn ? 'включён' : 'ВЫКЛЮЧЕН' });
  lines.push({ t: 'row', left: 'Разряд', right: b.dischargeFetOn ? 'включён' : 'ВЫКЛЮЧЕН' });
  lines.push({ t: 'row', left: 'Баланс. ячеек', right: b.balancingCells?.length ? `${b.balancingCells.length} шт.` : 'нет' });
  if (b.faults?.length) {
    for (const f of b.faults.slice(0, 6)) {
      lines.push({ t: 'row', left: '⚠ защита', right: f.label });
    }
  } else {
    lines.push({ t: 'row', left: 'Защиты', right: 'нет активных' });
  }
  lines.push({ t: 'divider' });

  if (b.hwVersion || b.swVersion || b.serial) {
    lines.push({ t: 'text', text: 'ПЛАТА', bold: true });
    if (b.hwVersion) lines.push({ t: 'row', left: 'HW', right: b.hwVersion });
    if (b.swVersion) lines.push({ t: 'row', left: 'SW', right: b.swVersion });
    if (b.serial) lines.push({ t: 'row', left: 'S/N', right: b.serial });
    if (b.prodDate) lines.push({ t: 'row', left: 'Дата', right: b.prodDate });
    lines.push({ t: 'divider' });
  }

  if (fleet && fleet.banks > 1) {
    lines.push({ t: 'text', text: `ВСЕГО В ПАРКЕ: ${fleet.online}/${fleet.banks}`, bold: true, align: 1 });
    lines.push({ t: 'row', left: 'Сумм. ток', right: `${n(fleet.currentSum, 2)} А` });
    lines.push({ t: 'row', left: 'Сумм. мощн.', right: `${n(fleet.powerSum, 1)} Вт` });
    lines.push({ t: 'row', left: 'Сумм. остаток', right: `${n(fleet.ahSum, 2)} / ${n(fleet.ahCapacity, 2)} Ач` });
    lines.push({ t: 'row', left: 'Макс Δ', right: `${mv(fleet.cellDelta)} мВ` });
    lines.push({ t: 'row', left: 'Т макс', right: `${n(fleet.tempMax, 1)} °C` });
    lines.push({ t: 'divider' });
  }

  lines.push({ t: 'text', text: 'JBD BMS · чек напечатан', align: 1 });
  lines.push({ t: 'text', text: new Date().toLocaleString('ru-RU'), align: 1 });
  lines.push({ t: 'cut' });
  return lines;
}

function buildFleetReceipt(rows, fleet, width) {
  const lines = [];
  lines.push({ t: 'text', text: 'СВОДКА ПО ПАРКУ АККУМУЛЯТОРОВ', align: 1, bold: true, size: 'big' });
  lines.push({ t: 'divider' });
  lines.push({ t: 'row', left: 'Плат всего', right: String(fleet?.banks ?? rows.length) });
  lines.push({ t: 'row', left: 'Онлайн', right: String(fleet?.online ?? rows.filter((r) => r.connected).length) });
  lines.push({ t: 'row', left: 'Нет связи', right: String(fleet?.stale ?? rows.filter((r) => !r.connected).length) });
  lines.push({ t: 'row', left: 'Сумм. напряжение', right: '—' });
  lines.push({ t: 'row', left: 'Сумм. ток', right: `${n(fleet?.currentSum, 2)} А` });
  lines.push({ t: 'row', left: 'Сумм. мощн.', right: `${n(fleet?.powerSum, 1)} Вт` });
  lines.push({ t: 'row', left: 'Общий остаток', right: `${n(fleet?.ahSum, 2)} / ${n(fleet?.ahCapacity, 2)} Ач` });
  lines.push({ t: 'row', left: 'Средний SOC', right: `${n(fleet?.socAvg, 0)} %` });
  lines.push({ t: 'row', left: 'Макс Δ банок', right: `${mv(fleet?.cellDelta)} мВ` });
  lines.push({ t: 'row', left: 'Т макс', right: `${n(fleet?.tempMax, 1)} °C` });
  lines.push({ t: 'row', left: 'Активных защит', right: String(fleet?.faults ?? 0) });
  lines.push({ t: 'divider' });

  lines.push({ t: 'text', text: 'ПЛАТЫ', bold: true });
  for (const b of rows) {
    const st = b.stats;
    const status = b.connected ? 'онлайн' : 'нет связи';
    lines.push({ t: 'text', text: `${b.label} · ${status}`, bold: true });
    const lineBits = [
      `${b.cellCount || b.cells.length}S`,
      `${n(b.voltage, 2)}В`,
      `${n(b.current, 1)}А`,
      `${n(b.power, 0)}Вт`,
      `SOC ${n(b.soc, 0)}%`,
    ];
    lines.push({ t: 'text', text: lineBits.join('  ') });
    if (st) {
      lines.push({ t: 'text', text: `мин ${(st.min/1000).toFixed(3).replace('.',',')}В · макс ${(st.max/1000).toFixed(3).replace('.',',')}В · Δ ${st.delta}мВ` });
    }
    if (b.faults?.length) {
      lines.push({ t: 'text', text: `⚠ ${b.faults.map((f) => f.label).join(', ')}` });
    }
    lines.push({ t: 'blank', n: 0 });
  }
  lines.push({ t: 'divider' });
  lines.push({ t: 'text', text: new Date().toLocaleString('ru-RU'), align: 1 });
  lines.push({ t: 'cut' });
  return lines;
}

function svcError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

export { buildBankReceipt, buildFleetReceipt, PRINTER_BAUDS };
