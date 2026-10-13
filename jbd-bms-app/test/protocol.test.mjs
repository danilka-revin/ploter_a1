// Протокол JBD: кадры, контрольные суммы, разбор ответов.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReadFrame, buildWriteFrame, buildFrameForResponse, extractResponses, checksum,
  parseBasicInfo, parseCellInfo, parseDeviceName, parseErrorCounters, decodeTemp, decodeDate,
  REG, FAULT_BITS,
} from '../scripts/jbd-protocol.mjs';

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

test('запрос базовой информации совпадает с документацией JBD: DD A5 03 00 FF FD 77', () => {
  assert.equal(buildReadFrame(REG.BASIC_INFO).toString('hex'), hex('DD A5 03 00 FF FD 77').toString('hex'));
});

test('запрос напряжений ячеек и имени: DD A5 04 00 FF FC 77 / DD A5 05 00 FF FB 77', () => {
  assert.equal(buildReadFrame(0x04).toString('hex'), 'dda504' + '00fffc77');
  assert.equal(buildReadFrame(0x05).toString('hex'), 'dda505' + '00fffb77');
});

test('запись кадра использует команду 5A', () => {
  const f = buildWriteFrame(0xe1, [0x03]);
  assert.equal(f[1], 0x5a);
  assert.equal(f[2], 0xe1);
  assert.equal(f[f.length - 1], 0x77);
});

test('контрольная сумма: 0x10000 минус сумма байтов', () => {
  assert.equal(checksum([0x03, 0x00]), 0xfffd);
  assert.equal(checksum([0x04, 0x00]), 0xfffc);
});

// Пример ответа из документации JBD (V4): DD 03 00 1B … FB FF 77
const DOC_RESPONSE = hex(
  'DD 03 00 1B 17 00 00 00 02 D0 03 E8 00 00 20 78 00 00 00 00 00 00 10 48 03 0F 02 0B 76 0B 82 FB FF 77',
);

test('разбор ответа из документации: кадр принят, контрольная сумма сходится', () => {
  const { frames, rest } = extractResponses(DOC_RESPONSE);
  assert.equal(frames.length, 1);
  assert.equal(rest.length, 0);
  assert.equal(frames[0].reg, 0x03);
  assert.equal(frames[0].status, 0x00);
  assert.equal(frames[0].data.length, 0x1b);
});

test('ответ с неверной контрольной суммой отбрасывается', () => {
  const bad = Buffer.from(DOC_RESPONSE);
  bad[bad.length - 2] ^= 0x01;
  assert.equal(extractResponses(bad).frames.length, 0);
});

test('мусор до кадра, два кадра подряд и неполный хвост', () => {
  const a = buildFrameForResponse(0x04, 0, Buffer.from([0x0d, 0x48, 0x0d, 0x49]));
  const b = buildFrameForResponse(0x05, 0, Buffer.from('JBD', 'ascii'));
  const stream = Buffer.concat([Buffer.from([0x00, 0x11, 0xdd]), a, b, a.subarray(0, 5)]);
  const { frames, rest } = extractResponses(stream);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].reg, 0x04);
  assert.equal(frames[1].reg, 0x05);
  assert.equal(rest.length, 5);
});

test('кадр со статусом ошибки 0x80 разбирается, данные пустые', () => {
  const err = buildFrameForResponse(0x10, 0x80, Buffer.alloc(0));
  const { frames } = extractResponses(err);
  assert.equal(frames[0].status, 0x80);
  assert.equal(frames[0].data.length, 0);
});

test('температура: (raw − 2731) / 10 °C', () => {
  assert.equal(decodeTemp(2731), 0);
  assert.equal(decodeTemp(2981), 25);
  assert.equal(decodeTemp(2731 - 200), -20);
});

test('дата производства: день 0–4, месяц 5–8, год от 2000 в битах 9–15', () => {
  const raw = ((2024 - 2000) << 9) | (5 << 5) | 17;
  assert.deepEqual(decodeDate(raw), { year: 2024, month: 5, day: 17 });
});

test('базовая информация: напряжение, ток (знаковый), ёмкость, NTC, защиты и балансировка', () => {
  const data = Buffer.alloc(23 + 2 * 2);
  data.writeUInt16BE(1330, 0);              // единицы по 10 мВ: 13.30 В
  data.writeInt16BE(-240, 2);               // −2.40 А (разряд)
  data.writeUInt16BE(6200, 4);              // 62.00 Ач
  data.writeUInt16BE(10000, 6);             // 100.00 Ач
  data.writeUInt16BE(127, 8);
  data.writeUInt16BE(((2024 - 2000) << 9) | (5 << 5) | 17, 10);
  data.writeUInt16BE(0b0000_0000_0000_0100, 12); // balance: ячейка 3
  data.writeUInt16BE(0, 14);
  data.writeUInt16BE(1 << 0 | 1 << 4, 16);  // перенапряжение ячейки + перегрев при заряде
  data[18] = 0x12;
  data[19] = 62;
  data[20] = 0x03;                          // заряд и разряд включены
  data[21] = 4;                             // 4 ячейки
  data[22] = 2;                             // 2 датчика
  data.writeUInt16BE(2981, 23);             // 25.0 °C
  data.writeUInt16BE(2931, 25);             // 20.0 °C

  const info = parseBasicInfo(data);
  assert.equal(info.packVoltage, 13.3);
  assert.equal(info.packCurrent, -2.4);
  assert.equal(info.remainingAh, 62);
  assert.equal(info.fullAh, 100);
  assert.equal(info.cycles, 127);
  assert.equal(info.capacityPct, 62);
  assert.equal(info.cellCount, 4);
  assert.deepEqual(info.temperatures, [25, 20]);
  assert.equal(info.chargeFetOn, true);
  assert.equal(info.dischargeFetOn, true);
  assert.deepEqual(info.balancingCells, [3]);
  assert.deepEqual(info.faults.map((f) => f.key), ['covp', 'chgot']);
  assert.equal(info.firmwareVersion, 0x12);
});

test('ФЕТ: бит 0 — заряд, бит 1 — разряд', () => {
  const data = Buffer.alloc(23);
  data[20] = 0x02; // только разряд
  const info = parseBasicInfo(data);
  assert.equal(info.chargeFetOn, false);
  assert.equal(info.dischargeFetOn, true);
});

test('короткий ответ базовой информации — понятная ошибка', () => {
  assert.throws(() => parseBasicInfo(Buffer.alloc(10)), /короче ожидаемого/);
});

test('напряжения ячеек — по два байта на ячейку', () => {
  const b = Buffer.alloc(8);
  [3301, 3302, 3299, 3350].forEach((v, i) => b.writeUInt16BE(v, i * 2));
  assert.deepEqual(parseCellInfo(b), [3301, 3302, 3299, 3350]);
});

test('имя устройства: ASCII без нулевых байтов', () => {
  assert.equal(parseDeviceName(Buffer.from('JBD-SP14S004\0\0', 'ascii')), 'JBD-SP14S004');
});

test('счётчики ошибок 0xAA: 11 значений в порядке bms-tools', () => {
  const b = Buffer.alloc(22);
  b.writeUInt16BE(7, 0);   // sc
  b.writeUInt16BE(3, 6);   // covp (индекс 3)
  const c = parseErrorCounters(b);
  assert.equal(c.sc, 7);
  assert.equal(c.covp, 3);
  assert.equal(c.puvp, 0);
});

test('таблица защит покрывает 13 битов без повторов', () => {
  const bits = FAULT_BITS.map((f) => f.bit);
  assert.equal(new Set(bits).size, bits.length);
  assert.equal(bits.length, 13);
});
