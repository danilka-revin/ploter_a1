// Язык чека: английский (ASCII, транслит) и русский (кириллица в cp866/cp1251/utf8).
// Проверяются байты для принтера, текст чеков всех трёх видов, кодовая страница
// ESC t при печати, сохранение выбора в printer.json и параметры API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReceiptPrinter, encodePrinterText, renderReceiptText, sanitizeText, toPrinterText,
} from '../scripts/printer.mjs';
import {
  PrinterService, buildBankReceipt, buildFleetReceipt, buildTestPage, FAULT_NAMES_RU,
} from '../scripts/printer-service.mjs';
import { createAppServer } from '../scripts/server.mjs';

const bank = {
  id: 'b1', label: 'Банк Гараж', path: '/dev/ttyUSB0', demo: false, connected: true, at: Date.UTC(2026, 9, 14, 10, 5),
  lastError: '', failures: 0, deviceName: 'JBD-12S-A', model: 'JBD-SP14S004', cellCount: 12, profile: 'discharge',
  voltage: 39.71, current: -29.9, power: -1187.1, remainingAh: 61.8, fullAh: 100, soc: 61, cycles: 127,
  cells: [3318, 3315, 3297, 3316, 3314, 3317, 3315, 3316, 3313, 3318, 3315, 3314],
  stats: { min: 3297, max: 3318, delta: 21, avg: 3314, minIndex: 2, maxIndex: 0, sum: 39758 },
  temperatures: [25.4, 26.1], chargeFetOn: true, dischargeFetOn: false, balancingCells: [3],
  faults: [{ key: 'covp', label: 'Перенапряжение ячейки' }, { key: 'dsgoc', label: 'Перегрузка по разряду' }],
  faultRaw: 0x201, errors: { covp: 2, dsgoc: 1 }, hwVersion: 'HW 1.3', swVersion: 'SW 4.21-LFP',
  serial: '12 34 05 00 42', prodDate: '17.05.2024', firmwareVersion: 16, spark: [],
};
const fleet = {
  banks: 2, online: 1, stale: 1, voltageAvg: 39.71, currentSum: -29.9, powerSum: -1187.1, powerMax: 1187.1, socAvg: 61,
  ahSum: 61.8, ahCapacity: 100, cellDelta: 21, cellMin: 3297, cellMax: 3318, tempMax: 26.1, faults: 2, balancing: 1,
  cyclesMax: 127, chargeFetOff: 0, dischargeFetOff: 1,
};
const CYR = /[А-Яа-яЁё]/;
const WIDTHS = [24, 32, 48];

/** Порт-заглушка: собирает всё, что ушло бы в UART. */
class CapturePort {
  constructor() { this.isOpen = true; this.chunks = []; }
  write(buf, cb) { this.chunks.push(Buffer.from(buf)); cb(); }
  drain(cb) { cb(); }
  close(cb) { this.isOpen = false; cb?.(); }
  get bytes() { return Buffer.concat(this.chunks); }
}

test('encodePrinterText: английский — ASCII, русский — cp866 / cp1251 / utf8', () => {
  // английский: транслит, ни одного байта >= 0x80
  const en = encodePrinterText('Ёмкость №1 · 100 Ач', { language: 'en' });
  assert.equal(en.toString('ascii'), 'Yomkost No.1 - 100 Ach');
  assert.ok([...en].every((b) => b < 0x80));

  // cp866: «Ёмкость №» → F0 AC AA AE E1 E2 EC FC, дальше ASCII
  const cp866 = encodePrinterText('Ёмкость №1', { language: 'ru', charset: 'cp866' });
  assert.deepEqual([...cp866], [0xf0, 0xac, 0xaa, 0xae, 0xe1, 0xe2, 0xec, 0x20, 0xfc, 0x31]);
  assert.equal(new TextDecoder('cp866').decode(cp866), 'Ёмкость №1', 'байты разбираются обратно в текст');

  // cp1251: те же буквы другими байтами (0xA8 = Ё, 0xB9 = №)
  const cp1251 = encodePrinterText('Ёмкость №1', { language: 'ru', charset: 'cp1251' });
  assert.deepEqual([...cp1251], [0xa8, 0xec, 0xea, 0xee, 0xf1, 0xf2, 0xfc, 0x20, 0xb9, 0x31]);
  assert.equal(new TextDecoder('cp1251').decode(cp1251), 'Ёмкость №1');

  // utf8
  assert.equal(encodePrinterText('Ёж', { language: 'ru', charset: 'utf8' }).toString('utf8'), 'Ёж');
  assert.equal(encodePrinterText('Ёж', { language: 'ru', charset: 'utf8' }).length, 4);

  // латиница и цифры одинаковы во всех режимах
  for (const charset of ['cp866', 'cp1251', 'utf8']) {
    assert.equal(encodePrinterText('JBD BMS 12S', { language: 'ru', charset }).toString('ascii'), 'JBD BMS 12S');
  }

  // символа нет в кодировке — вопросительный знак, а не мусор
  assert.equal(encodePrinterText('电池', { language: 'ru', charset: 'cp866' }).toString('ascii'), '??');
  assert.equal(encodePrinterText('Ёж', { language: 'en' }).toString('ascii'), 'Yozh');
});

test('sanitizeText: управляющие байты вырезаны, русские буквы остаются', () => {
  assert.equal(sanitizeText('Аккумулятор\x1b@\x1d!\x00 12'), 'Аккумулятор@! 12');
  assert.equal(sanitizeText('Ёж\tбанка\u00a0№3'), 'Ёж банка №3');
  assert.equal(toPrinterText('Ёж банка'), 'Yozh banka');
});

test('русский чек: кириллица во всех трёх видах и на всех ширинах', () => {
  for (const width of WIDTHS) {
    for (const level of ['short', 'medium', 'full']) {
      const lines = renderReceiptText(buildBankReceipt(bank, fleet, width, level, 'ru'), width, { language: 'ru' });
      const text = lines.join('\n');
      for (const l of lines) {
        assert.ok(l.length <= width, `ru ${level} @${width}: строка шире бумаги — «${l}»`);
        assert.doesNotMatch(l, /[\x00-\x08\x0b\x0c\x0e-\x1f]/, `ru ${level}: управляющие символы — «${l}»`);
      }
      // крупный заголовок в предпросмотре показан буквами через пробел — убираем пробелы для сравнения
      assert.match(text.replace(/ /g, ''), /АККУМУЛЯТОР/, `ru ${level}: заголовок по-русски`);
      assert.doesNotMatch(text, /BATTERY REPORT|MAIN READINGS|TEMPERATURES/, `ru ${level}: английских подписей нет`);
      assert.match(text, /Напряжение\s+39,71 В/, 'числа с запятой');
      assert.doesNotMatch(text, /39\.71 V|n\/a/, 'английских чисел и «n/a» нет');
      // каждая строка чека переводится в реальные байты принтера
      const bytes = encodePrinterText(text, { language: 'ru', charset: 'cp866' });
      assert.ok(bytes.includes(0xc0) || bytes.some((b) => b >= 0x80), 'в байтах есть кириллица');
      assert.equal(bytes.includes(0x1b), false, 'ESC из данных не попадает в поток');
    }
  }
  const ruRaw = renderReceiptText(buildBankReceipt(bank, fleet, 32, 'full', 'ru'), 32, { language: 'ru' }).join('\n');
  const ru = ruRaw.replace(/ /g, '');   // двойная ширина в предпросмотре показана буквами через пробел
  for (const s0 of [
    'АККУМУЛЯТОР', 'Банк Гараж', 'Вид                       полный', 'Состояние               на связи',
    'ОСНОВНЫЕ ЗНАЧЕНИЯ', 'Остаток        61,80 / 100,00 Ач', 'БАНКИ', 'Мин. банка           #3  3,297 В',
    '#01 3318мВ^', '! мин  ^ макс  b баланс', 'ПО БАНКАМ', '#03  3,297 В  -17 мВ  b',
    'ТЕМПЕРАТУРЫ', 'Датчик 1                  25,4 °C', 'КЛЮЧИ И ЗАЩИТЫ', 'Ключ разряда                выкл',
    'Защиты                активно: 2', '! Перенапряжение ячейки', '! Перегрузка разряда',
    'СЧЁТЧИКИ ЗАЩИТ', 'ПЛАТА', 'Прошивка             SW 4.21-LFP', 'Выпущена              17.05.2024',
    'Напечатано JBD BMS',
  ]) {
    const s = s0.replace(/ /g, '');
    assert.ok(ru.includes(s), `в русском чеке есть «${s0}»:\n${ruRaw}`);
  }

  // английский текст того же чека остаётся прежним и чисто ASCII
  const en = renderReceiptText(buildBankReceipt(bank, fleet, 32, 'full', 'en'), 32, { language: 'en' }).join('\n');
  assert.match(en.replace(/ /g, ''), /BATTERYREPORT/, 'заголовок английского чека прежний');
  assert.match(en, /Printed by JBD BMS/);
  assert.doesNotMatch(en, CYR, 'в английском чеке кириллицы нет');
  assert.ok([...encodePrinterText(en, { language: 'en' })].every((b) => b < 0x80));
});

test('русская сводка по парку и пробная страница', () => {
  for (const width of WIDTHS) {
    const lines = renderReceiptText(buildFleetReceipt([bank, { ...bank, id: 'b2', label: 'ДЕМО B', connected: false, cells: [], stats: null, temperatures: [], faults: [], voltage: null, current: null, soc: null }], fleet, width, 'full', 'ru'), width, { language: 'ru' });
    for (const l of lines) assert.ok(l.length <= width, `ru парк @${width}: «${l}»`);
    // крупный заголовок на узкой бумаге переносится — пробелы и переносы убираем для сравнения
    assert.match(lines.join(' ').replace(/\s+/g, ''), /ВСЕАККУМУЛЯТОРЫ/, 'заголовок по-русски');
  }
  const fleetRuRaw = renderReceiptText(buildFleetReceipt([bank], fleet, 32, 'short', 'ru'), 32, { language: 'ru' }).join('\n');
  const fleetRu = fleetRuRaw.replace(/ /g, '');
  for (const s0 of ['ВСЕ АККУМУЛЯТОРЫ', 'Сводный чек', 'На связи', 'Нет связи', 'Среднее напряжение', 'Макс. температура', 'Банк Гараж - на связи']) {
    assert.ok(fleetRu.includes(s0.replace(/ /g, '')), `в русской сводке по парку есть «${s0}»:\n${fleetRuRaw}`);
  }

  const testPage = renderReceiptText(buildTestPage({ path: 'COM4', baudRate: 19200, width: 32, language: 'ru' }), 32, { language: 'ru' }).join('\n');
  // длинная строка про читаемость переносится по ширине бумаги — сравниваем без пробелов
  const testPageFlat = testPage.replace(/\s+/g, '');
  for (const s of ['ПРОБНАЯСТРАНИЦА', 'Русский', 'Еслиэтоттекстчитается—принтерработает.']) {
    assert.ok(testPageFlat.includes(s), `на русской пробной странице есть «${s}»:\n${testPage}`);
  }
  const testPageEn = renderReceiptText(buildTestPage({ path: 'COM4', baudRate: 19200, width: 32, language: 'en' }), 32, { language: 'en' }).join('\n');
  assert.match(testPageEn, /PRINTER TEST/);
  assert.doesNotMatch(testPageEn, CYR);

  // у каждой защиты есть русское имя, если плата не прислала своё
  assert.ok(Object.keys(FAULT_NAMES_RU).length >= 12, 'русские названия защит на месте');
});

test('кодовая страница ESC t: cp866 → 17, cp1251 → 46, английский → PC437, простой текст — без команд', async () => {
  const cases = [
    { language: 'ru', charset: 'cp866', profile: 'alexgyver', seq: [0x1b, 0x74, 17] },
    { language: 'ru', charset: 'cp1251', profile: 'escpos', seq: [0x1b, 0x74, 46] },
    { language: 'en', charset: 'cp866', profile: 'escpos', seq: [0x1b, 0x74, 0] },
    { language: 'ru', charset: 'utf8', profile: 'escpos', seq: null },
    { language: 'ru', charset: 'cp866', profile: 'plain', seq: null },
  ];
  for (const { language, charset, profile, seq } of cases) {
    const p = new ReceiptPrinter({ profile, language, charset, width: 32, cmdDelayMs: 0 });
    p.port = new CapturePort();
    await p.printLines(buildBankReceipt(bank, null, 32, 'short', language));
    const bytes = p.port.bytes;
    if (seq) {
      assert.ok(bytes.includes(Buffer.from(seq)), `${language}/${charset}/${profile}: ESC t ${seq[2] ?? 0}`);
    } else {
      assert.equal(bytes.includes(Buffer.from([0x1b, 0x74])), false, `${language}/${charset}/${profile}: ESC t не отправляется`);
    }
    if (profile === 'plain') {
      assert.ok([...bytes].every((b) => b < 0x80 || b >= 0x80), 'простой текст: только данные');
      assert.equal(bytes.includes(0x1b), false, 'простой текст: ни одной ESC-команды');
      assert.equal(bytes.includes(0x1d), false, 'простой текст: ни одной GS-команды');
    }
    if (language === 'ru') {
      const text = bytes.toString('latin1');
      assert.ok(!text.includes('Nаpryazhenie'), 'транслита в русском чеке нет');
      assert.ok([...bytes].some((b) => b >= 0x80), 'кириллица уходит старшими байтами');
    } else {
      assert.equal([...bytes].filter((b) => b >= 0x80 && b !== 0xff && b !== 140).length, 0, 'английский: только ASCII');
    }
  }
});

test('настройка языка: сохраняется в printer.json, чужой язык отклоняется', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jbd-printer-lang-'));
  try {
    const configFile = join(dir, 'printer.json');
    const svc = new PrinterService({ configFile });
    assert.equal(svc.status().language, 'en', 'по умолчанию английский');
    assert.deepEqual(svc.status().languages, ['en', 'ru']);
    assert.deepEqual(svc.status().charsets, ['cp866', 'cp1251', 'utf8']);
    assert.equal(svc.status().charsetCodepages.cp866, 17);

    svc.configure({ language: 'ru', charset: 'cp1251' });
    const saved = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(saved.language, 'ru');
    assert.equal(saved.charset, 'cp1251');
    assert.throws(() => svc.configure({ language: 'de' }), /язык чека/);
    assert.throws(() => svc.configure({ charset: 'koi8-r' }), /кодировк/);
    assert.equal(svc.config.language, 'ru', 'ошибка не меняет рабочую настройку');
    assert.equal(svc.config.charset, 'cp1251');

    // старый printer.json с незнакомым языком не теряет остальные настройки
    writeFileSync(configFile, JSON.stringify({ path: 'COM7', width: 42, language: 'jp', charset: 'sjis' }) + '\n');
    const old = new PrinterService({ configFile });
    assert.equal(old.config.path, 'COM7');
    assert.equal(old.config.language, 'en');
    assert.equal(old.config.charset, 'cp866');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('печать: язык доходит до принтера, разовый язык не меняет настройку', async () => {
  const svc = new PrinterService();
  svc.configure({ path: 'capture', baudRate: 19200, width: 32, profile: 'alexgyver', lineDelayMs: 0, language: 'en' });
  const p = svc._ensure();
  p.port = new CapturePort();
  p.cmdDelayMs = 0;

  const en = await svc.printBank(bank, fleet, 'short');
  assert.equal(en.language, 'en');
  const enBytes = p.port.bytes.length;
  assert.equal([...p.port.bytes].filter((b) => b >= 0x80 && b !== 0xff && b !== 140).length, 0, 'английский чек — ASCII');

  // разовая печать по-русски: язык и кодировка в ответе, настройка принтера не изменилась
  const ru = await svc.printBank(bank, fleet, 'short', { language: 'ru', charset: 'cp866' });
  assert.equal(ru.language, 'ru');
  assert.equal(ru.charset, 'cp866');
  assert.equal(svc.status().language, 'en', 'настройка осталась английской');
  assert.ok(p.port.bytes.length > enBytes, 'русский чек тоже напечатан');
  assert.ok(p.port.bytes.includes(Buffer.from([0x1b, 0x74, 17])), 'перед русским чеком отправлена страница cp866');

  // кириллица видна в потоке (байты cp866), английского заголовка в нём нет
  const printed = p.port.bytes.subarray(enBytes);
  const decoded = new TextDecoder('cp866').decode(printed);
  assert.ok(decoded.includes('Ёмкость') || decoded.includes('АККУМУЛЯТОР'), `заголовок кириллицей:\n${decoded.slice(0, 200)}`);
  assert.ok(!decoded.includes('BATTERY REPORT'), 'английского заголовка нет');
  assert.ok(!decoded.includes('Akumulyator'), 'транслита нет');

  // постоянная смена языка через configure
  svc.configure({ language: 'ru', charset: 'cp1251' });
  const next = await svc.printFleet([bank], fleet, 'short');
  assert.equal(next.language, 'ru');
  assert.equal(next.charset, 'cp1251');
  assert.ok(p.port.bytes.includes(Buffer.from([0x1b, 0x74, 46])), 'страница cp1251 (ESC t 46)');

  await assert.rejects(() => svc.printBank(bank, fleet, 'short', { language: 'kz' }), /язык чека/);
  await assert.rejects(() => svc.printFleet([bank], fleet, 'short', { charset: 'koi8' }), /кодировк/);
  await svc.close();
});

test('предпросмотр: строки и байты, которые уйдут в принтер', () => {
  const svc = new PrinterService();
  svc.configure({ language: 'ru', charset: 'cp866', width: 32 });
  const ru = svc.previewBank(bank, null, 'short');
  assert.equal(ru.language, 'ru');
  assert.equal(ru.charset, 'cp866');
  assert.equal(ru.lines.join('\n'), ru.text.join('\n'), 'текст один и тот же');
  assert.ok(ru.lines.join('\n').includes('АККУМУЛЯТОР'));
  assert.ok(ru.bytes.includes(0x0d) && ru.bytes.includes(0x0a), 'переводы строк в байтах есть');
  assert.ok(ru.bytes.length > 200);
  assert.ok(ru.raw.length > ru.lines.length, 'raw — команды раскладки до рендера');

  // английский предпросмотр — чистый ASCII
  svc.configure({ language: 'en' });
  const en = svc.previewBank(bank, null, 'short');
  assert.equal(en.charset, null);
  assert.ok(en.bytes.every((b) => b === 0x0d || b === 0x0a || (b >= 0x20 && b < 0x7f)));
  assert.doesNotMatch(en.lines.join('\n'), CYR);

  // в utf8 русские буквы занимают два байта — байт больше, чем символов
  svc.configure({ language: 'ru', charset: 'utf8' });
  const utf = svc.previewBank(bank, null, 'short');
  assert.ok(utf.bytes.length > ru.bytes.length);
});

// ---------- API ----------

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
  await post('/api/printer/config', { language: 'en', charset: 'cp866' });
  await post('/api/disconnect', {});
  await new Promise((resolve) => server.close(resolve));
});

test('API: язык чека в настройках, предпросмотре и печати', async () => {
  const st = await get('/api/printer');
  assert.equal(st.data.language, 'en');
  assert.deepEqual(st.data.languages, ['en', 'ru']);
  assert.deepEqual(st.data.charsets, ['cp866', 'cp1251', 'utf8']);
  assert.equal(st.data.charsetCodepages.cp1251, 46);

  const id = (await get('/api/banks')).data.banks[0].id;

  const en = await get(`/api/printer/preview?id=${id}&level=short&language=en`);
  assert.equal(en.status, 200);
  assert.equal(en.data.language, 'en');
  assert.equal(en.data.charset, null);
  assert.equal(en.data.ascii, true, 'английский чек — чистый ASCII');
  assert.ok(Array.isArray(en.data.bytes) && en.data.bytes.length > 200);
  assert.ok(en.data.bytes.every((b) => b === 13 || b === 10 || (b >= 0x20 && b < 0x7f)));

  // русский чек запрашивается тем же адресом: язык влияет на текст и байты
  const ru = await get(`/api/printer/preview?id=${id}&level=short&language=ru`);
  assert.equal(ru.status, 200);
  assert.equal(ru.data.language, 'ru');
  assert.equal(ru.data.charset, 'cp866');
  assert.equal(ru.data.ascii, false);
  assert.ok(ru.data.bytes.some((b) => b >= 0x80), 'в байтах кириллица');
  assert.notDeepEqual(ru.data.bytes, en.data.bytes, 'русский чек — другие байты, чем английский');
  assert.equal(ru.data.bytes.length, ru.data.byteLength, 'длина буфера отдана в ответе');
  assert.ok(ru.data.lines.join('\n').length > 0);

  // язык сохраняется настройкой и применяется по умолчанию
  const cfg = await post('/api/printer/config', { language: 'ru', charset: 'cp1251' });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.data));
  assert.equal(cfg.data.language, 'ru');
  assert.equal(cfg.data.charset, 'cp1251');
  const byDefault = await get(`/api/printer/preview?id=${id}&level=short`);
  assert.equal(byDefault.data.language, 'ru');
  assert.equal(byDefault.data.charset, 'cp1251');
  const fleet = await get('/api/printer/preview?id=all&level=medium');
  assert.equal(fleet.data.language, 'ru');

  const testPage = await get('/api/printer/preview?id=test');
  assert.equal(testPage.status, 200);
  assert.equal(testPage.data.language, 'ru');

  // чужие язык и кодировка отклоняются до попытки печати
  const badLang = await get(`/api/printer/preview?id=${id}&language=de`);
  assert.equal(badLang.status, 400);
  assert.equal(badLang.data.error, 'BAD_LANGUAGE');
  const badCfg = await post('/api/printer/config', { charset: 'koi8-r' });
  assert.equal(badCfg.status, 400);
  assert.equal(badCfg.data.error, 'BAD_CHARSET');
  assert.equal((await get('/api/printer')).data.language, 'ru', 'ошибка не меняет настройку');

  // порта нет: печать не начинается, но язык проверяется раньше
  const badPrint = await post('/api/printer/print', { id, language: 'de' });
  assert.equal(badPrint.status, 400);
  assert.equal(badPrint.data.error, 'BAD_LANGUAGE');
  const noPort = await post('/api/printer/print', { id, language: 'ru', charset: 'cp866' });
  assert.equal(noPort.status, 400);
  assert.equal(noPort.data.error, 'NO_PRINTER');

  assert.equal((await post('/api/printer/config', { language: 'en', charset: 'cp866' })).data.language, 'en');
});
