// Разбор Intel HEX: контрольные суммы, сегменты, обрезанные файлы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntelHex } from '../scripts/intel-hex.mjs';
import { inspectFirmwareFile, flashFirmware, FirmwareError } from '../scripts/firmware.mjs';

/** Строка Intel HEX с корректной контрольной суммой. */
function rec(addr, type, bytes) {
  const body = [bytes.length, (addr >> 8) & 0xff, addr & 0xff, type, ...bytes];
  const sum = body.reduce((a, b) => (a + b) & 0xff, 0);
  const cs = (0x100 - sum) & 0xff;
  return ':' + [...body, cs].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}
const EOF = rec(0, 1, []);

test('корректный файл: данные, один сегмент, SHA-256', () => {
  const text = [rec(0x0000, 0, [1, 2, 3, 4]), rec(0x0004, 0, [5, 6]), EOF].join('\n');
  const r = parseIntelHex(text);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.bytes, 6);
  assert.deepEqual(r.segments.map((s) => [s.address, s.length]), [[0, 6]]);
  assert.equal(r.segments[0].bytes.toString('hex'), '010203040506');
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
});

test('разрыв адресов даёт два сегмента с собственными байтами', () => {
  const text = [rec(0x0000, 0, [0xaa]), rec(0x0100, 0, [0xbb, 0xcc]), EOF].join('\n');
  const r = parseIntelHex(text);
  assert.equal(r.ok, true);
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[1].address, 0x100);
  assert.equal(r.segments[1].bytes.toString('hex'), 'bbcc');
});

test('линейный адрес типа 04 сдвигает базу на 64 КБ', () => {
  const text = [rec(0, 4, [0x00, 0x08]), rec(0x10, 0, [0x77]), EOF].join('\n');
  const r = parseIntelHex(text);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.minAddress, 0x80000 + 0x10);
});

test('неверная контрольная сумма записи — файл отклоняется', () => {
  const good = rec(0, 0, [1, 2]);
  const bad = good.slice(0, -2) + (good.slice(-2) === '00' ? '01' : '00');
  const r = parseIntelHex([bad, EOF].join('\n'));
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /контрольная сумма/);
});

test('нет записи конца файла — файл считается обрезанным', () => {
  const r = parseIntelHex(rec(0, 0, [1, 2, 3]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /обрезан/);
});

test('пустой файл и строка без двоеточия', () => {
  assert.equal(parseIntelHex(EOF).ok, false);
  const r = parseIntelHex(['xx' + rec(0, 0, [1]).slice(1), EOF].join('\n'));
  assert.equal(r.ok, false);
});

test('строка с обрезанными данными (длина не совпадает)', () => {
  const r = parseIntelHex([':0500000001020304', EOF].join('\n'));
  assert.equal(r.ok, false);
});

test('неизвестный тип записи', () => {
  const r = parseIntelHex([rec(0, 0x09, [1]), rec(0, 0, [1]), EOF].join('\n'));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /неизвестный тип/);
});

test('ответ инспекции не содержит байт прошивки, только адреса', () => {
  const text = [rec(0x0000, 0, [1, 2, 3]), EOF].join('\n');
  const info = inspectFirmwareFile(text, 'SP14S.hex');
  assert.equal(info.ok, true);
  assert.equal(info.fileName, 'SP14S.hex');
  assert.equal(info.segments[0].bytes, undefined);
  assert.equal(info.canWrite, false);
  assert.match(info.writeBlockedReason, /не подтверждён/);
});

test('запись прошивки без подтверждённого протокола отказывает и не трогает BMS', async () => {
  const text = [rec(0, 0, [1, 2, 3]), EOF].join('\n');
  const image = parseIntelHex(text);
  let touched = false;
  const client = { read: async () => { touched = true; }, write: async () => { touched = true; } };
  await assert.rejects(flashFirmware(client, image), (e) => e instanceof FirmwareError && e.code === 'PROTOCOL_UNKNOWN');
  assert.equal(touched, false);
});
