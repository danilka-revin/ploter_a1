// Мусор вместо текста на бумаге — почти всегда несовпадение скорости UART
// (у 58-мм модулей бывает 9600 и 19200). Проверяем автопоиск по ответу
// принтера, перебор скоростей печатью и запрос состояния.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SerialPort } from 'serialport';
import {
  ReceiptPrinter, PRINTER_BAUDS, PRINTER_FRAMINGS, STATUS_QUERIES, framingOptions, describeStatusByte,
} from '../scripts/printer.mjs';
import { PrinterService, baudSweepLines } from '../scripts/printer-service.mjs';

/**
 * Порт-заглушка «настоящего» принтера: отвечает на запрос состояния только
 * тогда, когда скорость и формат кадра порта совпали с настройками принтера.
 * На чужой скорости живой принтер молчит (либо отвечает мусором — для этого
 * есть режим garbage).
 */
class FakePrinterPort {
  constructor({ answerAt = 19200, framing = '8N1', statusByte = 0x12, mode = 'answer' } = {}) {
    this.isOpen = true;
    this.chunks = [];
    this.baudRate = 9600;
    this.framing = '8N1';
    this.answerAt = answerAt;
    this.answerFraming = framing;
    this.statusByte = statusByte;
    this.mode = mode;   // 'answer' | 'silent' | 'garbage'
    this.updates = [];
    this._listeners = new Map();
  }

  on(ev, fn) { this._listeners.set(ev, [...(this._listeners.get(ev) ?? []), fn]); }
  off(ev, fn) { this._listeners.set(ev, (this._listeners.get(ev) ?? []).filter((f) => f !== fn)); }
  _emit(ev, arg) { for (const fn of this._listeners.get(ev) ?? []) fn(arg); }

  write(buf, cb) {
    const chunk = Buffer.from(buf);
    this.chunks.push(chunk);
    const query = STATUS_QUERIES.find((q) => q.bytes.equals(chunk));
    if (query && this.mode !== 'silent' && this.baudRate === this.answerAt && this.framing === this.answerFraming) {
      // чужая скорость: байт приходит, но у него нет обязательных битой статуса (бит 0 = 0, бит 1 = 1)
      const answer = this.mode === 'garbage' ? Buffer.from([0x00]) : Buffer.from([this.statusByte]);
      setTimeout(() => this._emit('data', answer), 1);
    }
    cb?.();
  }

  drain(cb) { cb?.(); }
  update(opts, cb) {
    this.updates.push({ ...opts });
    this.baudRate = opts.baudRate ?? this.baudRate;
    if (opts.dataBits === 7 && opts.parity === 'even') this.framing = '7E1';
    else if (opts.dataBits === 8 && opts.parity === 'even') this.framing = '8E1';
    else this.framing = '8N1';
    cb?.();
  }

  close(cb) { this.isOpen = false; cb?.(); }
  get bytes() { return Buffer.concat(this.chunks); }
}

function service(port, config = {}) {
  const svc = new PrinterService();
  svc.configure({ path: '/dev/ttyFAKE', baudRate: 9600, width: 32, lineDelayMs: 0, ...config });
  const p = svc._ensure();
  p.cmdDelayMs = 0;
  // порт открыт на той же линии, что настроена у принтера
  port.baudRate = p.baudRate;
  port.framing = p.framing;
  p.port = port;
  return { svc, p };
}

test('скорости и форматы кадра: список для UI и маска порта', () => {
  assert.ok(PRINTER_BAUDS.includes(9600) && PRINTER_BAUDS.includes(19200) && PRINTER_BAUDS.includes(115200));
  assert.deepEqual(PRINTER_FRAMINGS, ['8N1', '8E1', '7E1']);
  assert.deepEqual(framingOptions('8N1'), { dataBits: 8, parity: 'none', stopBits: 1 });
  assert.deepEqual(framingOptions('7E1'), { dataBits: 7, parity: 'even', stopBits: 1 });
  assert.deepEqual(framingOptions('мусор'), { dataBits: 8, parity: 'none', stopBits: 1 });
  assert.equal(STATUS_QUERIES.length >= 3, true, 'несколько известных запросов состояния');
  for (const q of STATUS_QUERIES) assert.ok(q.bytes.every((b) => b < 0x80), 'запросы не печатают текст');
});

test('байт состояния: бумага есть, бумага кончилась, мусор', () => {
  const ok = describeStatusByte(0x12);
  assert.equal(ok.plausible, true);
  assert.equal(ok.paperOut, false);
  assert.match(ok.text, /бумага есть/);
  const out = describeStatusByte(0x16);
  assert.equal(out.paperOut, true);
  assert.match(out.text, /НЕТ БУМАГИ/);
  assert.equal(describeStatusByte(0x5a).plausible, true, '0x5A — настоящий статус DLE EOT 1');
  assert.equal(describeStatusByte(0x03).plausible, false, 'бит 0 всегда 0');
  const junk = describeStatusByte(0x00);
  assert.equal(junk.plausible, false);
  assert.match(junk.text, /чужая скорость|не похож/);
});

test('setLine меняет скорость и формат кадра у открытого порта', async () => {
  const port = new FakePrinterPort();
  const p = new ReceiptPrinter({ path: '/dev/ttyFAKE', profile: 'plain', cmdDelayMs: 0 });
  p.port = port;
  await p.setLine({ baudRate: 19200, framing: '8E1' });
  assert.deepEqual(port.updates.at(-1), { baudRate: 19200, dataBits: 8, parity: 'even', stopBits: 1 });
  assert.equal(p.baudRate, 19200);
  assert.equal(p.framing, '8E1');
});

test('автопоиск находит скорость, на которой принтер отвечает', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jbd-printer-detect-'));
  try {
    const configFile = join(dir, 'printer.json');
    const svc = new PrinterService({ configFile });
    svc.configure({ path: '/dev/ttyFAKE', baudRate: 9600, lineDelayMs: 0 });
    const p = svc._ensure();
    p.cmdDelayMs = 0;
    const port = new FakePrinterPort({ answerAt: 19200 });
    p.port = port;

    const r = await svc.detectBaud({ bauds: [9600, 19200, 115200], framings: ['8N1'], timeoutMs: 30 });
    assert.equal(r.found, true);
    assert.equal(r.baudRate, 19200, 'рабочая скорость сохранена в настройках');
    assert.equal(r.framing, '8N1');
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0].hex, '12');
    assert.equal(r.hits[0].confirmed, true, 'ответ повторился — это не случайный байт');
    assert.match(r.message, /19200/);
    assert.equal(svc.status().baudRate, 19200);
    assert.equal(svc.status().framing, '8N1');
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).baudRate, 19200, 'скорость переживает перезапуск');
    assert.equal(svc.status().printing, false);
    // порт вернулся на найденную скорость, а не остался на последней из перебора
    assert.equal(port.baudRate, 19200);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('автопоиск перебирает форматы кадра и молчащий принтер объясняет причины', async () => {
  const port = new FakePrinterPort({ answerAt: 19200, framing: '7E1' });
  const { svc } = service(port);
  const r = await svc.detectBaud({ bauds: [9600, 19200], framings: ['8N1', '7E1', '8E1'], timeoutMs: 20 });
  assert.equal(r.found, true);
  assert.deepEqual([r.baudRate, r.framing], [19200, '7E1'], 'формат кадра тоже подбирается');
  assert.ok(r.hits[0].query, 'видно, какая команда вызвала ответ');

  const silent = new FakePrinterPort({ mode: 'silent' });
  const s2 = service(silent).svc;
  const r2 = await s2.detectBaud({ bauds: [9600, 19200], framings: ['8N1'], timeoutMs: 20 });
  assert.equal(r2.found, false);
  assert.equal(r2.tried, 2);
  assert.match(r2.message, /TX принтера → RX адаптера/);
  assert.match(r2.message, /RS-232/);
  assert.equal(s2.status().baudRate, 9600, 'неудачный поиск не меняет настройки');
});

test('неправдоподобный ответ (чужая скорость) не считается рабочей', async () => {
  const port = new FakePrinterPort({ answerAt: 9600, mode: 'garbage' });
  const { svc } = service(port);
  const r = await svc.detectBaud({ bauds: [9600], framings: ['8N1'], timeoutMs: 20 });
  assert.equal(r.found, true, 'ответ есть — скорость, скорее всего, верная');
  assert.equal(r.hits[0].status.plausible, false, 'но байт не похож на статус принтера');
});

test('запрос состояния: ответ на своей скорости и молчание на чужой', async () => {
  const port = new FakePrinterPort({ answerAt: 19200 });
  const { svc } = service(port, { baudRate: 19200 });
  const ok = await svc.queryPrinter({ timeoutMs: 30 });
  assert.equal(ok.ok, true);
  assert.equal(ok.paper, 'ok');
  assert.equal(ok.hex, '12');
  assert.match(ok.message, /19200/);
  assert.equal(svc.status().printing, false);

  const port2 = new FakePrinterPort({ answerAt: 115200 });
  const { svc: svc2 } = service(port2, { baudRate: 9600 });
  const silent = await svc2.queryPrinter({ timeoutMs: 20 });
  assert.equal(silent.ok, false);
  assert.equal(silent.paper, 'unknown');
  assert.match(silent.message, /Найти скорость/);

  const port3 = new FakePrinterPort({ answerAt: 9600, statusByte: 0x16 });
  const { svc: svc3 } = service(port3, { baudRate: 9600 });
  assert.equal((await svc3.queryPrinter({ timeoutMs: 30 })).paper, 'out');
});

test('перебор скоростей печатает блок на каждой и возвращает прежнюю настройку', async () => {
  const port = new FakePrinterPort({ mode: 'silent' });
  const { svc, p } = service(port, { baudRate: 9600 });
  const r = await svc.sweepBauds({ bauds: [9600, 19200, 115200], paceMs: 0 });
  assert.deepEqual(r.printed, [9600, 19200, 115200]);
  const text = port.bytes.toString('latin1');
  for (const b of [9600, 19200, 115200]) {
    assert.ok(text.includes(`${b} 8N1`), `в потоке есть блок ${b}`);
  }
  assert.ok(text.includes('Hello 123 ABC abc +-*/'));
  assert.match(r.message, /читаемый блок|читается/);
  assert.equal(p.lineDelayMs, 0, 'пауза после перебора возвращается как была');
  assert.equal(svc.status().baudRate, 9600, 'скорость в настройках не меняется перебором');
  assert.equal(port.baudRate, 9600, 'порт возвращается на прежнюю скорость');
  assert.equal(svc.status().printing, false);

  const lines = baudSweepLines(19200, '8N1');
  assert.equal(lines[1].text, '19200 8N1');
  for (const ln of lines) if (ln.t === 'text') assert.ok(ln.text.length <= 24, 'блок влезает в узкую бумагу');
});

test('настройки принтера: формат кадра проверяется и сохраняется', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jbd-printer-framing-'));
  try {
    const configFile = join(dir, 'printer.json');
    const svc = new PrinterService({ configFile });
    assert.equal(svc.status().framing, '8N1');
    assert.throws(() => svc.configure({ framing: '8N9' }), (e) => e.code === 'BAD_FRAMING');
    svc.configure({ framing: '8E1' });
    assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).framing, '8E1');
    const next = new PrinterService({ configFile });
    assert.equal(next.status().framing, '8E1');
    assert.deepEqual(next.status().framings, PRINTER_FRAMINGS);
    assert.equal(next.status().bauds.includes(2400), true, 'в списке скоростей есть и медленные');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Сквозная проверка через настоящий последовательный порт: запрос состояния
// уходит и ответ принтера возвращается, а перебор скоростей печатает все блоки.
test('настоящий последовательный порт (socat): запрос состояния и перебор скоростей', async (t) => {
  if (spawnSync('which', ['socat']).status !== 0) { t.skip('socat не установлен'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'jbd-printer-baud-'));
  const printerEnd = join(dir, 'printer');
  const hostEnd = join(dir, 'host');
  const socat = spawn('socat', [`pty,raw,echo=0,link=${printerEnd}`, `pty,raw,echo=0,link=${hostEnd}`], { stdio: 'ignore' });
  let fake = null;
  try {
    for (let i = 0; i < 100 && !(existsSync(printerEnd) && existsSync(hostEnd)); i++) await new Promise((r) => setTimeout(r, 50));
    // «принтер»: отвечает байтом состояния на запрос, всё остальное копит в лог
    const got = [];
    fake = await new Promise((resolve, reject) => {
      const port = new SerialPort({ path: printerEnd, baudRate: 9600, autoOpen: false });
      port.open((err) => (err ? reject(err) : resolve(port)));
    });
    fake.on('data', (chunk) => {
      got.push(Buffer.from(chunk));
      if (STATUS_QUERIES.some((q) => chunk.includes(q.bytes))) fake.write(Buffer.from([0x12]));
    });

    const svc = new PrinterService();
    svc.configure({ path: hostEnd, baudRate: 9600, width: 32, profile: 'plain', lineDelayMs: 0 });
    svc._ensure().cmdDelayMs = 2;

    const query = await svc.queryPrinter({ timeoutMs: 120 });
    assert.equal(query.ok, true, 'принтер ответил на запрос состояния');
    assert.equal(query.paper, 'ok');

    const detect = await svc.detectBaud({ bauds: [9600, 19200], framings: ['8N1'], timeoutMs: 60 });
    assert.equal(detect.found, true, 'автопоиск увидел ответ');

    const sweep = await svc.sweepBauds({ bauds: [9600, 19200], paceMs: 0 });
    await new Promise((r) => setTimeout(r, 150));
    const text = Buffer.concat(got).toString('latin1');
    assert.deepEqual(sweep.printed, [9600, 19200]);
    for (const b of [9600, 19200]) assert.ok(text.includes(`${b} 8N1`), `блок ${b} дошёл до принтера`);
    await svc.close();
  } finally {
    if (fake?.isOpen) await new Promise((r) => fake.close(() => r()));
    socat.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('во время печати автопоиск и запрос состояния не запускаются', async () => {
  const port = new FakePrinterPort({ mode: 'silent' });
  const { svc, p } = service(port);
  p.lineDelayMs = 20;
  const printing = svc.testPage();
  await assert.rejects(svc.detectBaud(), (e) => e.code === 'PRINTER_BUSY');
  await assert.rejects(svc.queryPrinter(), (e) => e.code === 'PRINTER_BUSY');
  await assert.rejects(svc.sweepBauds(), (e) => e.code === 'PRINTER_BUSY');
  await printing;
});
