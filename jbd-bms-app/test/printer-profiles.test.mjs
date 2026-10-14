import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptPrinter } from '../scripts/printer.mjs';
import { PrinterService } from '../scripts/printer-service.mjs';

class CapturePort {
  isOpen = true;
  chunks = [];
  write(buf, cb) { this.chunks.push(Buffer.from(buf)); cb(); }
  drain(cb) { cb(); }
  close(cb) { this.isOpen = false; cb(); }
  get bytes() { return Buffer.concat(this.chunks); }
}

for (const profile of ['plain', 'escpos', 'alexgyver']) {
  test(`профиль ${profile}: только свои команды, читаемый текст`, async () => {
    const p = new ReceiptPrinter({ profile, width: 48, cmdDelayMs: 0 });
    p.port = new CapturePort();
    await p.printLines([{ t: 'text', text: 'Hello 123 ABC abc', size: 'big', bold: true }]);
    const bytes = p.port.bytes;
    const text = bytes.toString('latin1');
    assert.ok(text.includes('Hello 123 ABC abc'));
    if (profile === 'plain') {
      assert.match(text, /^[\x20-\x7e\r\n]+$/);
      assert.ok(text.startsWith('Hello 123 ABC abc\r\n'));
    } else {
      assert.ok(bytes.includes(Buffer.from([27, 64])));
      assert.equal(bytes.includes(Buffer.from([27, 55])), profile === 'alexgyver');
      assert.equal(bytes.includes(255), profile === 'alexgyver');
      assert.equal(bytes.includes(140), profile === 'alexgyver');
    }
  });
}

test('диагностика UART не отправляет ESC-команды даже в профиле AlexGyver', async () => {
  const svc = new PrinterService();
  svc.configure({ path: 'capture', baudRate: 19200, profile: 'alexgyver', lineDelayMs: 0 });
  svc._ensure().port = new CapturePort();
  const r = await svc.diagnostic();
  assert.equal(r.ok, true);
  assert.equal(svc.printer.port.bytes.toString('ascii'), '\r\nUART 19200 8N1\r\nHello 123 ABC abc +-*/\r\n\r\n');
  assert.equal(svc.status().printing, false);
});

test('настройки принтера переживают перезапуск; простой текст — безопасный default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jbd-printer-cfg-'));
  try {
    const configFile = join(dir, 'printer.json');
    const svc = new PrinterService({ configFile });
    assert.equal(svc.status().profile, 'plain');
    assert.equal(svc.status().lineDelayMs, 800);
    svc.configure({ path: 'COM8', baudRate: 19200, width: 42, profile: 'escpos', lineDelayMs: 1500 });
    const next = new PrinterService({ configFile });
    assert.deepEqual(next.config, svc.config);
    assert.throws(() => next.configure({ profile: 'wrong' }), /профиль/);
    assert.throws(() => next.configure({ profile: 'plain', lineDelayMs: -10 }), /Пауза/);
    assert.equal(next.config.profile, 'escpos', 'ошибка валидации не меняет рабочую конфигурацию');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('во время печати нельзя менять скорость, порт или начинать вторую печать', async () => {
  const svc = new PrinterService();
  svc.configure({ path: 'capture', lineDelayMs: 0 });
  const p = svc._ensure();
  p.port = new CapturePort();
  const printing = svc.testPage();
  assert.throws(() => svc.configure({ baudRate: 115200 }), (e) => e.code === 'PRINTER_BUSY');
  await assert.rejects(svc.diagnostic(), (e) => e.code === 'PRINTER_BUSY');
  await printing;
  assert.equal(svc.status().printing, false);
  const bytes = p.port.bytes.toString('ascii');
  for (const line of svc.previewTest().lines) assert.ok(bytes.includes(line + '\r\n'), line);
});

test('пауза печати ждёт механику, а не только drain()', async () => {
  const p = new ReceiptPrinter({ profile: 'plain', lineDelayMs: 40, cmdDelayMs: 0 });
  p.port = new CapturePort();
  const start = performance.now();
  await p.printLines(['One', 'Two', { t: 'feed', n: 1 }]);
  assert.ok(performance.now() - start >= 105);
});
