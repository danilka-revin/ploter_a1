// Чековый принтер: чек на английском и только ASCII — без кириллицы, CP866 и
// «странных символов», строки не шире бумаги, в порт уходят только байты < 0x80.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SerialPort } from 'serialport';
import { ReceiptPrinter, layoutReceipt, renderReceiptText, toPrinterText } from '../scripts/printer.mjs';
import {
  PrinterService, buildBankReceipt, buildFleetReceipt, buildTestPage, FAULT_NAMES_EN,
} from '../scripts/printer-service.mjs';
import { FAULT_BITS } from '../scripts/jbd-protocol.mjs';

const ASCII_LINE = /^[\x20-\x7e]*$/;
const WIDTHS = [24, 32, 36, 42, 48];

/** Строка банка той же формы, что отдаёт banks.row(): русская подпись и русские названия защит. */
const bank = {
  id: 'b1', label: 'Банк Гараж', path: '/dev/ttyUSB0', demo: false, connected: true, at: Date.UTC(2026, 9, 14, 10, 5),
  lastError: '', failures: 0, deviceName: 'JBD-12S-A', model: 'JBD-SP14S004', cellCount: 12, profile: 'discharge',
  voltage: 39.71, current: -29.9, power: -1187.1, remainingAh: 61.8, fullAh: 100, soc: 61, cycles: 127,
  cells: [3318, 3315, 3297, 3316, 3314, 3317, 3315, 3316, 3313, 3318, 3315, 3314],
  stats: { min: 3297, max: 3318, delta: 21, avg: 3314, minIndex: 2, maxIndex: 0, sum: 39758 },
  temperatures: [25.4, 26.1], chargeFetOn: true, dischargeFetOn: false, balancingCells: [3],
  faults: [{ key: 'covp', label: 'Перенапряжение ячейки' }, { key: 'dsgoc', label: 'Перегрузка по разряду' }], faultRaw: 0x201,
  errors: null, hwVersion: 'HW 1.3', swVersion: 'SW 4.21-LFP', serial: '12 34 05 00 42', prodDate: '17.05.2024',
  firmwareVersion: 16, spark: [],
};
const offline = {
  ...bank, id: 'b2', label: 'ДЕМО B', connected: false, voltage: null, current: null, power: null, soc: null,
  remainingAh: null, fullAh: null, cells: [], stats: null, temperatures: [], faults: [], balancingCells: [],
  chargeFetOn: null, dischargeFetOn: null,
};
const fleet = {
  banks: 2, online: 1, stale: 1, voltageAvg: 39.71, currentSum: -29.9, powerSum: -1187.1, socAvg: 61,
  ahSum: 61.8, ahCapacity: 100, cellDelta: 21, tempMax: 26.1, faults: 2, balancing: 1,
};

function assertPrintable(lines, width, what) {
  assert.ok(lines.length > 5, `${what}: чек не пустой`);
  for (const l of lines) {
    assert.match(l, ASCII_LINE, `${what}: только ASCII — «${l}»`);
    assert.ok(l.length <= width, `${what}: строка шире ${width} симв. — «${l}»`);
  }
}

test('toPrinterText: кириллица транслитом, знаки — ASCII-заменами, управляющие байты вырезаны', () => {
  assert.equal(toPrinterText('Банк 1'), 'Bank 1');
  assert.equal(toPrinterText('ДЕМО A'), 'DEMO A');
  assert.equal(toPrinterText('Щука и ЩУКА, Ёж'), 'Shchuka i SHCHUKA, Yozh');
  assert.equal(toPrinterText('25 °C · Δ 12 мВ — №3 «ok» 2…3'), '25 degC - d 12 mV - No.3 "ok" 2...3');
  assert.equal(toPrinterText('Café Ünïcode'), 'Cafe Unicode');
  assert.equal(toPrinterText('A\x1b@B\x1d!C\x00D\tE'), 'A@B!CD E', 'ESC/GS/NUL из данных не станут командой принтера');
  assert.equal(toPrinterText('电池 ⚠'), '?? !');
  assert.equal(toPrinterText(null), '');
  for (const s of ['Перенапряжение ячейки', 'Ёмкость 100 Ач', '中文', '\u{1F50B} 3,3 В']) {
    assert.match(toPrinterText(s), ASCII_LINE, s);
  }
});

test('сводка по аккумулятору — на английском, ASCII, по ширине бумаги', () => {
  for (const width of WIDTHS) assertPrintable(renderReceiptText(buildBankReceipt(bank, fleet, width), width), width, `банк @${width}`);

  const ops = layoutReceipt(buildBankReceipt(bank, fleet, 32), 32);
  assert.ok(ops.some((o) => o.text === 'BATTERY REPORT' && o.size === 'big'), 'заголовок крупно');
  const text = renderReceiptText(buildBankReceipt(bank, fleet, 32), 32).join('\n');
  for (const s of [
    'Bank Garazh', 'Model: JBD-SP14S004', 'MAIN READINGS', 'Voltage', '39.71 V', '-29.90 A', '-1187.1 W', '61 %',
    '61.80 / 100.00 Ah', 'Cycles', '127', '12S', 'Lowest cell', '#3  3.297 V', 'Highest cell', '#1  3.318 V',
    '21 mV', '#01 3318mV^', '#03 3297mV!b', '! min  ^ max  b balancing', 'TEMPERATURES', 'Sensor T1', '25.4 C',
    'Charge FET', 'Discharge FET', 'OFF', '1 cell', '2 ACTIVE', '! Cell overvoltage', '! Discharge overcurrent',
    'Firmware', 'SW 4.21-LFP', 'Manufactured', '2024-05-17', 'ALL BATTERIES: 1/2 ONLINE', 'Printed by JBD BMS',
  ]) assert.ok(text.includes(s), `в чеке есть «${s}»:\n${text}`);
  assert.doesNotMatch(text, /39,71|n\/a V|undefined|NaN|null/, 'десятичная точка, без мусора');
  assert.match(text, /^Status {2,}online$/m, 'строка «название … значение» во всю ширину');
});

test('сводка без связи с платой: «OFFLINE» и «n/a» вместо чисел', () => {
  const text = renderReceiptText(buildBankReceipt(offline, null, 32), 32);
  assertPrintable(text, 32, 'офлайн');
  const all = text.join('\n');
  assert.match(all, /DEMO B/);
  assert.match(all, /^Status {2,}OFFLINE$/m);
  assert.match(all, /^Voltage {2,}n\/a$/m);
  assert.match(all, /- no cell data -/);
  assert.match(all, /- no sensors -/);
  assert.match(all, /none active/);
  assert.doesNotMatch(all, /ALL BATTERIES/, 'итоги парка — только если плат больше одной');
});

test('сводка по парку — на английском, ASCII, по ширине бумаги', () => {
  for (const width of WIDTHS) assertPrintable(renderReceiptText(buildFleetReceipt([bank, offline], fleet, width), width), width, `парк @${width}`);
  const text = renderReceiptText(buildFleetReceipt([bank, offline], fleet, 32), 32).join('\n');
  for (const s of [
    'A L L   B A T T E R I E S', 'Summary report', 'Boards', 'Offline', 'Average voltage', 'Total current',
    '61.8 / 100.0 Ah', 'Active protections', 'BATTERIES', 'Bank Garazh - online',
    '39.71 V  -29.9 A  -1187 W', 'SOC 61 %  12S  delta 21 mV', 'min 3.297 V  max 3.318 V', '! Cell overvoltage',
    'DEMO B - OFFLINE\n- no data -',
  ]) assert.ok(text.includes(s), `в чеке есть «${s}»:\n${text}`);
  assert.match(text, /^Total remaining +61\.8 \/ 100\.0 Ah$/m);
  assert.doesNotMatch(text, /n\/a {2}n\/a/, 'плата без данных — одной строкой «no data»');
});

test('пробная страница — на английском, линейка ровно в ширину строки', () => {
  for (const width of WIDTHS) {
    const lines = renderReceiptText(buildTestPage({ path: 'COM4', baudRate: 19200, width }), width);
    assertPrintable(lines, width, `пробная @${width}`);
    assert.ok(lines.includes('1234567890'.repeat(5).slice(0, width)), 'линейка ширины');
  }
  const text = renderReceiptText(buildTestPage({ path: 'COM4', baudRate: 19200, width: 32 }), 32).join('\n');
  assert.match(text, /PRINTER TEST/);
  assert.match(text, /^Baud rate {2,}19200 baud$/m);
  assert.match(text, /English \(ASCII\)/);
});

test('у каждой защиты протокола есть английское название', () => {
  for (const f of FAULT_BITS) assert.ok(FAULT_NAMES_EN[f.key], `нет перевода для «${f.key}»`);
});

/** Порт-заглушка: собирает всё, что ушло бы в UART. */
class CapturePort {
  constructor() { this.isOpen = true; this.chunks = []; }
  write(buf, cb) { this.chunks.push(Buffer.from(buf)); cb(); }
  drain(cb) { cb(); }
  close(cb) { this.isOpen = false; cb?.(); }
  get bytes() { return Buffer.concat(this.chunks); }
}

const count = (buf, seq) => {
  let n = 0;
  for (let i = buf.indexOf(seq); i !== -1; i = buf.indexOf(seq, i + 1)) n++;
  return n;
};

test('в порт принтера уходят только байты < 0x80: ESC/POS-команды и английский текст', async () => {
  const p = new ReceiptPrinter({ path: 'capture', width: 32, cmdDelayMs: 0 });
  p.port = new CapturePort();
  await p.printLines(buildBankReceipt(bank, fleet, 32));
  const bytes = p.port.bytes;
  const high = [...bytes].filter((b) => b >= 0x80);
  assert.deepEqual(high, [], 'ни одного байта ≥ 0x80 — нечему превратиться в иероглифы или «кракозябры»');
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1b, 0x40], 'начало — ESC @ (сброс принтера)');
  assert.equal(count(bytes, Buffer.from([0x1b, 0x52, 0x00])), 1, 'ESC R 0 — набор символов США');
  assert.equal(count(bytes, Buffer.from([0x1b, 0x74, 0x00])), 1, 'ESC t 0 — PC437');
  assert.equal(count(bytes, Buffer.from([0x1b, 0x74, 17])), 0, 'кодовая страница CP866 больше не включается');
  assert.equal(count(bytes, Buffer.from([0x1d, 0x56, 0x42, 0x00])), 1, 'один отрез в конце, без лишней ленты');
  const text = bytes.toString('latin1');
  for (const s of ['BATTERY REPORT', 'Bank Garazh', 'Voltage', '39.71 V', '! Cell overvoltage', 'Printed by JBD BMS']) {
    assert.ok(text.includes(s), `в потоке есть «${s}»`);
  }
});

test('сервис: настройка ширины применяется к уже открытому принтеру, кодировки больше нет', async () => {
  const svc = new PrinterService();
  const st = svc.configure({ path: '/dev/ttyFAKE', ascii: false, charPage: 17 });
  assert.equal(st.language, 'en');
  assert.equal('ascii' in st, false);
  assert.equal('charPage' in st, false);
  const p = svc._ensure();
  p.port = new CapturePort();
  p.cmdDelayMs = 0;
  svc.configure({ width: 42 });
  const r = await svc.testPage();
  assert.equal(r.ok, true);
  const text = p.port.bytes.toString('latin1');
  assert.ok(text.includes('123456789012345678901234567890123456789012\n'), 'линейка в новую ширину 42');
  assert.ok([...p.port.bytes].every((b) => b < 0x80));

  const prev = svc.previewBank(bank, fleet);
  assert.equal(prev.kind, 'bank');
  assert.equal(prev.width, 42);
  assertPrintable(prev.lines, 42, 'предпросмотр');
  assert.equal(svc.previewFleet([bank], fleet).kind, 'fleet');
  assert.match(svc.previewTest().lines.join('\n'), /PRINTER TEST/);
  await svc.close();
});

test('настоящий последовательный порт (socat): принтер получает английский чек только в ASCII', async (t) => {
  if (spawnSync('which', ['socat']).status !== 0) { t.skip('socat не установлен'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'jbd-printer-'));
  const printerEnd = join(dir, 'printer');
  const hostEnd = join(dir, 'host');
  const socat = spawn('socat', [`pty,raw,echo=0,link=${printerEnd}`, `pty,raw,echo=0,link=${hostEnd}`], { stdio: 'ignore' });
  let sink = null;
  try {
    for (let i = 0; i < 100 && !(existsSync(printerEnd) && existsSync(hostEnd)); i++) await new Promise((r) => setTimeout(r, 50));
    // «принтер» — второй конец пары: просто копим всё, что пришло по UART
    const got = [];
    sink = await new Promise((resolve, reject) => {
      const port = new SerialPort({ path: printerEnd, baudRate: 9600, autoOpen: false });
      port.open((err) => (err ? reject(err) : resolve(port)));
    });
    sink.on('data', (chunk) => got.push(chunk));

    const svc = new PrinterService();
    svc.configure({ path: hostEnd, baudRate: 9600, width: 32 });
    svc._ensure().cmdDelayMs = 2;
    const r = await svc.printFleet([bank, offline], fleet);
    assert.equal(r.ok, true);
    await svc.close();
    await new Promise((res) => setTimeout(res, 200));

    const bytes = Buffer.concat(got);
    assert.ok(bytes.length > 500, `принтер получил ${bytes.length} байт`);
    assert.deepEqual([...bytes].filter((b) => b >= 0x80), [], 'ни одного байта ≥ 0x80');
    const text = bytes.toString('latin1');
    for (const s of ['ALL BATTERIES', 'Summary report', 'Bank Garazh - online', 'DEMO B - OFFLINE', '! Cell overvoltage']) {
      assert.ok(text.includes(s), `принтер получил «${s}»`);
    }
  } finally {
    if (sink?.isOpen) await new Promise((r) => sink.close(() => r()));
    socat.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});
