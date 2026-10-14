// Три вида чека чекового принтера: короткий (short), средний (medium), полный (full).
// Проверяются состав каждого вида, сохранение вида в printer.json, длина чека
// и параметры API (level у печати и предпросмотра).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderReceiptText } from '../scripts/printer.mjs';
import { PrinterService, REPORT_LEVELS, buildBankReceipt, buildFleetReceipt } from '../scripts/printer-service.mjs';
import { createAppServer } from '../scripts/server.mjs';

const ASCII_LINE = /^[\x20-\x7e]*$/;

const bank = {
  id: 'b1', label: 'Банк Гараж', path: '/dev/ttyUSB0', demo: false, connected: true, at: Date.UTC(2026, 9, 14, 10, 5),
  lastError: '', failures: 0, deviceName: 'JBD-12S-A', model: 'JBD-SP14S004', cellCount: 12, profile: 'discharge',
  voltage: 39.71, current: -29.9, power: -1187.1, remainingAh: 61.8, fullAh: 100, soc: 61, cycles: 127,
  cells: [3318, 3315, 3297, 3316, 3314, 3317, 3315, 3316, 3313, 3318, 3315, 3314],
  stats: { min: 3297, max: 3318, delta: 21, avg: 3314, minIndex: 2, maxIndex: 0, sum: 39758 },
  temperatures: [25.4, 26.1], chargeFetOn: true, dischargeFetOn: false, balancingCells: [3],
  faults: [{ key: 'covp', label: 'Перенапряжение ячейки' }, { key: 'dsgoc', label: 'Перегрузка по разряду' }], faultRaw: 0x201,
  errors: { covp: 2, dsgoc: 1, sc: 0 }, hwVersion: 'HW 1.3', swVersion: 'SW 4.21-LFP', serial: '12 34 05 00 42',
  prodDate: '17.05.2024', firmwareVersion: 16, spark: [],
};
const offline = {
  ...bank, id: 'b2', label: 'ДЕМО B', connected: false, voltage: null, current: null, power: null, soc: null,
  remainingAh: null, fullAh: null, cells: [], stats: null, temperatures: [], faults: [], balancingCells: [],
  chargeFetOn: null, dischargeFetOn: null, errors: null,
};
const fleet = {
  banks: 2, online: 1, stale: 1, voltageAvg: 39.71, currentSum: -29.9, powerSum: -1187.1, powerMax: 1187.1, socAvg: 61,
  ahSum: 61.8, ahCapacity: 100, cellDelta: 21, cellMin: 3297, cellMax: 3318, tempMax: 26.1, faults: 2, balancing: 1,
  cyclesMax: 127, chargeFetOff: 0, dischargeFetOff: 1,
};

/** Порт-заглушка: собирает всё, что ушло бы в UART. */
class CapturePort {
  constructor() { this.isOpen = true; this.chunks = []; }
  write(buf, cb) { this.chunks.push(Buffer.from(buf)); cb(); }
  drain(cb) { cb(); }
  close(cb) { this.isOpen = false; cb?.(); }
  get bytes() { return Buffer.concat(this.chunks); }
}

const render = (b, lvl, width = 32) => renderReceiptText(b, width, lvl);

test('виды чека по аккумулятору: короткий ⊂ средний ⊂ полный', () => {
  const short = renderReceiptText(buildBankReceipt(bank, fleet, 32, 'short'), 32);
  const medium = renderReceiptText(buildBankReceipt(bank, fleet, 32, 'medium'), 32);
  const full = renderReceiptText(buildBankReceipt(bank, fleet, 32, 'full'), 32);
  const shortText = short.join('\n'), mediumText = medium.join('\n'), fullText = full.join('\n');

  // короткий: только главное, без блоков и без сетки банок
  for (const s of ['Voltage', '39.71 V', '-29.90 A', '-1187.1 W', 'State of charge', 'Remaining', 'Lowest cell', 'Delta (max-min)', 'Max temperature', 'Protections']) {
    assert.ok(shortText.includes(s), `в коротком чеке есть «${s}»:\n${shortText}`);
  }
  assert.doesNotMatch(shortText, /MAIN READINGS|^CELLS$|TEMPERATURES|SWITCHES|BOARD|PROTECTION COUNTERS|CELL DETAIL/m,
    'в коротком чеке нет заголовков блоков и паспорта платы');
  assert.doesNotMatch(shortText, /3318mV/, 'сетка банок в короткий чек не входит');
  assert.match(shortText, /^Report {2,}short$/m, 'вид чека напечатан на бумаге');

  // средний: сетка банок, температуры и ключи, но без паспорта платы и счётчиков
  assert.match(mediumText, /#01 3318mV\^/, 'сетка банок');
  assert.match(mediumText, /^Sensor T2 {2,}26\.1 C$/m, 'температуры по датчикам');
  assert.match(mediumText, /^Charge FET {2,}on$/m, 'ключи заряда и разряда');
  assert.doesNotMatch(mediumText, /BOARD|PROTECTION COUNTERS|CELL DETAIL/, 'паспорт платы и счётчики — только в полном');

  // полный: всё выше + каждая банка строкой, счётчики защит и паспорт платы
  for (const s of ['BOARD', 'Firmware', 'SW 4.21-LFP', 'Manufactured', '2024-05-17', 'PROTECTION COUNTERS', 'CELL DETAIL']) {
    assert.ok(fullText.includes(s), `в полном чеке есть «${s}»:\n${fullText}`);
  }
  assert.match(fullText, /^#12 {2}3\.314 V {2}0 mV$/m, 'каждая банка отдельной строкой');
  assert.ok(fullText.includes(shortText.split('\n')[1]), 'подпись аккумулятора одна и та же во всех видах');

  assert.ok(short.length < medium.length && medium.length < full.length,
    `короткий (${short.length}) < средний (${medium.length}) < полный (${full.length})`);
});

test('виды чека по парку: короткий держится в 6 строк на плату, полный печатает паспорт каждой', () => {
  const rows = [bank, offline];
  for (const level of REPORT_LEVELS) {
    for (const width of [24, 32, 48]) {
      const lines = renderReceiptText(buildFleetReceipt(rows, fleet, width, level), width);
      for (const l of lines) {
        assert.match(l, ASCII_LINE, `${level} @${width}: только ASCII — «${l}»`);
        assert.ok(l.length <= width, `${level} @${width}: строка шире бумаги — «${l}»`);
      }
    }
  }
  const shortLines = renderReceiptText(buildFleetReceipt(rows, fleet, 32, 'short'), 32);
  const mediumLines = renderReceiptText(buildFleetReceipt(rows, fleet, 32, 'medium'), 32);
  const fullLines = renderReceiptText(buildFleetReceipt(rows, fleet, 32, 'full'), 32);
  const short = shortLines.join('\n'), medium = mediumLines.join('\n'), full = fullLines.join('\n');

  for (const t of [short, medium, full]) {
    for (const s of ['A L L   B A T T E R I E S', 'Summary report', 'BATTERIES', '1. Bank Garazh - online', '2. DEMO B - OFFLINE', '- no data -']) {
      assert.ok(t.includes(s), `в чеке парка есть «${s}»:\n${t}`);
    }
  }
  assert.match(short, /^Report {2,}short$/m, 'вид чека в шапке');
  // короткий чек: подпись платы и не больше двух строк данных, без пустых строк между платами
  const first = shortLines.findIndex((l) => l.startsWith('1. Bank Garazh'));
  const second = shortLines.findIndex((l) => l.startsWith('2. DEMO B'));
  assert.ok(first > 0 && second > first, `обе платы в коротком чеке:\n${short}`);
  const briefBlock = shortLines.slice(first + 1, second);
  // подпись, одна-две строки данных и не больше двух защит, без пустых строк
  assert.ok(briefBlock.length <= 4 && !briefBlock.includes(''), `короткий блок платы — без пустых строк:\n${short}`);
  assert.ok(briefBlock.filter((l) => l.startsWith('! ')).length <= 2, 'в коротком чеке — первые две защиты');
  assert.ok(briefBlock.join(' ').includes('39.71 V'), 'главные числа платы на месте');
  // средний и полный: платы разделены пустой строкой, крайние банки перечислены
  const mediumFirst = mediumLines.findIndex((l) => l.startsWith('1. Bank Garazh'));
  const mediumSecond = mediumLines.findIndex((l) => l.startsWith('2. DEMO B'));
  assert.equal(mediumLines[mediumSecond - 1], '', 'между платами пустая строка');
  const mediumBlock = mediumLines.slice(mediumFirst + 1, mediumSecond - 1).join(' ');
  for (const s of ['39.71 V', 'SOC 61 %', 'delta 21 mV', 'min 3.297 V', 'max 3.318 V']) {
    assert.ok(mediumBlock.includes(s), `в среднем чеке есть «${s}»:\n${medium}`);
  }
  assert.ok(shortLines.length < mediumLines.length && mediumLines.length < fullLines.length,
    `короткий (${shortLines.length}) < средний (${mediumLines.length}) < полный (${fullLines.length})`);
  for (const s of ['Cycles (max)', 'Balancing cells', 'FETs off chg/dsg', 'model JBD-SP14S004', 'fw SW 4.21-LFP', 'sn 12 34 05 00 42', 'made 2024-05-17', 'T 25.4/26.1 C']) {
    assert.ok(full.includes(s), `в полном чеке парка есть «${s}»:\n${full}`);
  }
  assert.doesNotMatch(medium + short, /Cycles \(max\)|model JBD-SP14S004/, 'паспорт платы — только в полном');
});

test('вид чека: настройка сохраняется, незнакомый отклоняется, старый файл читается', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jbd-printer-level-'));
  try {
    const configFile = join(dir, 'printer.json');
    const svc = new PrinterService({ configFile });
    assert.equal(svc.status().reportLevel, 'medium', 'по умолчанию — средний чек');
    assert.deepEqual(svc.status().reportLevels, REPORT_LEVELS);
    assert.equal(svc.configure({ reportLevel: 'short' }).reportLevel, 'short');
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).reportLevel, 'short', 'вид чека сохранён в printer.json');
    assert.throws(() => svc.configure({ reportLevel: 'huge' }), /вид чека/);
    assert.equal(svc.config.reportLevel, 'short', 'ошибка не меняет рабочую настройку');

    // старый printer.json без вида чека не ломает остальные настройки
    writeFileSync(configFile, JSON.stringify({ path: 'COM7', baudRate: 19200, width: 42 }) + '\n');
    const old = new PrinterService({ configFile });
    assert.equal(old.config.path, 'COM7');
    assert.equal(old.config.reportLevel, 'medium');

    writeFileSync(configFile, JSON.stringify({ path: 'COM7', reportLevel: 'chto-to' }) + '\n');
    const broken = new PrinterService({ configFile });
    assert.equal(broken.config.path, 'COM7', 'опечатка в виде чека не теряет порт');
    assert.equal(broken.config.reportLevel, 'medium');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('печать: выбранный вид чека доходит до принтера и попадает в ответ', async () => {
  const svc = new PrinterService();
  svc.configure({ path: 'capture', baudRate: 19200, width: 32, profile: 'plain', lineDelayMs: 0 });
  const p = svc._ensure();
  p.port = new CapturePort();
  p.cmdDelayMs = 0;

  const short = await svc.printBank(bank, fleet, 'short');
  assert.equal(short.level, 'short');
  const shortBytes = p.port.bytes.length;
  const shortText = p.port.bytes.toString('latin1');
  assert.ok(!shortText.includes('CELL DETAIL'));

  const full = await svc.printBank(bank, fleet, 'full');
  assert.equal(full.level, 'full');
  assert.ok(p.port.bytes.length > shortBytes, 'полный чек печатается дольше короткого');
  assert.ok(p.port.bytes.toString('latin1').includes('CELL DETAIL'), 'полный чек содержит разбор банок');

  // без указания вида печатается вид из настроек принтера
  svc.configure({ reportLevel: 'short' });
  const byDefault = await svc.printBank(bank, fleet);
  assert.equal(byDefault.level, 'short');
  assert.equal(svc.status().reportLevel, 'short');

  const fleetShort = await svc.printFleet([bank, offline], fleet);
  assert.equal(fleetShort.level, 'short');
  assert.equal(fleetShort.banks, 2);

  // чужой вид чека не печатается и не портит настройки
  await assert.rejects(() => svc.printBank(bank, fleet, 'medium-plus'), /вид чека/);
  assert.equal(svc.status().reportLevel, 'short');

  assert.equal(svc.previewBank(bank, fleet, 'full').level, 'full');
  assert.equal(svc.previewFleet([bank], fleet, 'medium').level, 'medium');
  assert.ok(svc.previewBank(bank, fleet, 'short').lines.length < svc.previewBank(bank, fleet, 'full').lines.length);
  await svc.close();
});

// ---------- API: level у предпросмотра и печати ----------

let server;
let base = '';

async function get(path) {
  const r = await fetch(base + path, { cache: 'no-store' });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  return { status: r.status, data };
}
async function post(path, body) {
  const r = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' || body === undefined ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  return { status: r.status, data };
}

before(async () => {
  server = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const demo = await post('/api/banks/demo', { count: 2 });
  assert.equal(demo.status, 200, JSON.stringify(demo.data));
  for (let i = 0; i < 80; i++) {
    const p = await get('/api/panel');
    if (p.data.banks.length === 2 && p.data.banks.every((b) => b.voltage !== null && b.cells.length > 0)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  await post('/api/disconnect', {});
  await new Promise((resolve) => server.close(resolve));
});

test('API: предпросмотр и печать принимают вид чека, чужой вид — ошибка', async () => {
  const status = await get('/api/printer');
  assert.equal(status.status, 200);
  assert.equal(status.data.reportLevel, 'medium', 'средний чек по умолчанию');
  assert.deepEqual(status.data.reportLevels, ['short', 'medium', 'full']);

  const id = (await get('/api/banks')).data.banks[0].id;
  const sizes = {};
  for (const level of ['short', 'medium', 'full']) {
    const preview = await get(`/api/printer/preview?id=${id}&level=${level}`);
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.level, level);
    assert.equal(preview.data.kind, 'bank');
    assert.ok(preview.data.lines.every((l) => ASCII_LINE.test(l) && l.length <= preview.data.width), preview.data.lines.join('\n'));
    assert.match(preview.data.lines.join('\n'), new RegExp(`^Report +${level}$`, 'm'), 'вид чека напечатан в шапке');
    sizes[level] = preview.data.lines.length;
  }
  assert.ok(sizes.short < sizes.medium && sizes.medium < sizes.full, `short < medium < full: ${JSON.stringify(sizes)}`);

  // вид чека из настроек применяется, когда level не передан
  const cfg = await post('/api/printer/config', { reportLevel: 'short' });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.data));
  assert.equal(cfg.data.reportLevel, 'short');
  const byDefault = await get(`/api/printer/preview?id=${id}`);
  assert.equal(byDefault.data.level, 'short');
  const fleetPreview = await get('/api/printer/preview?id=all&level=full');
  assert.equal(fleetPreview.data.level, 'full');
  assert.equal(fleetPreview.data.kind, 'fleet');
  assert.ok(fleetPreview.data.lines.length > byDefault.data.lines.length);

  // пробная страница вид чека не использует
  const testPage = await get('/api/printer/preview?id=test&level=full');
  assert.equal(testPage.status, 200);
  assert.equal(testPage.data.level, null);

  const badPreview = await get(`/api/printer/preview?id=${id}&level=huge`);
  assert.equal(badPreview.status, 400);
  assert.equal(badPreview.data.error, 'BAD_LEVEL');

  const badConfig = await post('/api/printer/config', { reportLevel: 'huge' });
  assert.equal(badConfig.status, 400);
  assert.equal(badConfig.data.error, 'BAD_LEVEL');
  assert.equal((await get('/api/printer')).data.reportLevel, 'short', 'ошибка не меняет настройку');

  // порта нет: печать не начинается, но вид чека проверяется до неё
  const noPort = await post('/api/printer/print', { id, level: 'full' });
  assert.equal(noPort.status, 400);
  assert.equal(noPort.data.error, 'NO_PRINTER');
  const badLevel = await post('/api/printer/print', { id, level: 'huge' });
  assert.equal(badLevel.status, 400);
  assert.equal(badLevel.data.error, 'BAD_LEVEL');

  // вернуть средний вид, чтобы не влиять на другие проверки
  assert.equal((await post('/api/printer/config', { reportLevel: 'medium' })).data.reportLevel, 'medium');
});
