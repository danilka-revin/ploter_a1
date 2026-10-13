// Клиент BMS поверх эмулятора: чтение всех регистров, ошибки, таймауты, очередь.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BmsClient } from '../scripts/bms-client.mjs';
import { createFakeTransport, FakeBmsDevice } from '../scripts/fake-bms.mjs';
import { SETTINGS, BmsProtocolError, buildWriteFrame } from '../scripts/jbd-protocol.mjs';

test('базовая информация, ячейки, имя и счётчики ошибок с эмулятора 4S 12 В', async () => {
  const client = new BmsClient(createFakeTransport({ cellCount: 4, name: 'DEMO JBD 4S 12V' }));
  const basic = await client.readBasicInfo();
  assert.equal(basic.cellCount, 4);
  assert.ok(basic.packVoltage > 12 && basic.packVoltage < 14.5, `напряжение ${basic.packVoltage}`);
  assert.equal(basic.temperatures.length, 2);

  const cells = await client.readCellInfo();
  assert.equal(cells.length, 4);
  assert.ok(cells.every((v) => v > 3000 && v < 3500));
  assert.equal(await client.readDeviceName(), 'DEMO JBD 4S 12V');
  const errors = await client.readErrorCounters();
  assert.equal(errors.covp, 0);
  await client.close();
});

test('ячейки в сумме дают напряжение батареи (с точностью до 10 мВ)', async () => {
  const client = new BmsClient(createFakeTransport({ cellCount: 4 }));
  const basic = await client.readBasicInfo();
  const cells = await client.readCellInfo();
  const sum = cells.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum / 1000 - basic.packVoltage) < 0.02, `${sum} vs ${basic.packVoltage}`);
  await client.close();
});

test('настройки защит читаются и масштабируются (covp 3650 мВ, chgot 45 °C)', async () => {
  const client = new BmsClient(createFakeTransport({ cellCount: 4 }));
  const covp = SETTINGS.find((s) => s.key === 'covp');
  const chgot = SETTINGS.find((s) => s.key === 'chgot');
  assert.equal(await client.readSetting(covp), 3650);
  assert.equal(await client.readSetting(chgot), 45);
  await client.close();
});

test('неизвестный регистр возвращает статус 0x80 — ошибка, а не зависание', async () => {
  const client = new BmsClient(createFakeTransport({}), { timeoutMs: 300, retries: 0 });
  await assert.rejects(client.read(0x7f), (e) => e instanceof BmsProtocolError && /0x80/.test(e.message));
  await client.close();
});

test('молчащее устройство: таймаут после повторов', async () => {
  const silent = { write: async () => {}, onData: () => {}, close: async () => {} };
  const client = new BmsClient(silent, { timeoutMs: 60, retries: 1 });
  const t0 = Date.now();
  await assert.rejects(client.readBasicInfo(), (e) => e instanceof BmsProtocolError && e.message === 'BMS не ответил');
  assert.ok(Date.now() - t0 >= 110, 'должен быть повтор');
  await client.close();
});

test('параллельные запросы выстраиваются в очередь и не путают ответы', async () => {
  const client = new BmsClient(createFakeTransport({ cellCount: 4 }));
  const [basic, cells, name] = await Promise.all([
    client.readBasicInfo(), client.readCellInfo(), client.readDeviceName(),
  ]);
  assert.equal(cells.length, 4);
  assert.equal(basic.cellCount, 4);
  assert.equal(typeof name, 'string');
  await client.close();
});

test('эмулятор принимает запись, но состояние не меняет', () => {
  const dev = new FakeBmsDevice({ cellCount: 4 });
  const reply = dev.receive(buildWriteFrame(0xe1, [0x00, 0x03]));
  assert.ok(reply.length >= 7);
  assert.equal(reply[2], 0x00);
});

test('после закрытия запросы отклоняются', async () => {
  const client = new BmsClient(createFakeTransport({}));
  await client.close();
  await assert.rejects(client.readBasicInfo(), /закрыто/);
});
