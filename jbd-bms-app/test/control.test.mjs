// Управление: ключи заряда/разряда, остаток ёмкости, сброс счётчиков — на эмуляторе платы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CTRL_REG, fetRaw, capRemRaw } from '../scripts/jbd-protocol.mjs';
import { BmsClient } from '../scripts/bms-client.mjs';
import { createFakeTransport } from '../scripts/fake-bms.mjs';

test('ключи: биты регистра 0xE1 (бит = выключено)', () => {
  assert.equal(fetRaw({ charge: true, discharge: true }), 0);
  assert.equal(fetRaw({ charge: false, discharge: true }), 1);
  assert.equal(fetRaw({ charge: true, discharge: false }), 2);
  assert.equal(fetRaw({ charge: false, discharge: false }), 3);
});

test('остаток ёмкости: Ач → регистр (единица 10 мАч)', () => {
  assert.equal(capRemRaw(62), 6200);
  assert.throws(() => capRemRaw(-1));
  assert.throws(() => capRemRaw(1000));
});

test('ключи переключаются в эмуляторе и читаются в базовой информации', async () => {
  const transport = createFakeTransport({ latencyMs: 1 });
  const client = new BmsClient(transport, { timeoutMs: 300, retries: 0 });
  await client.writeSettings([{ reg: CTRL_REG.CHG_DSG_EN, raw: fetRaw({ charge: false, discharge: true }) }], { save: false });
  const b = await client.readBasicInfo();
  assert.equal(b.chargeFetOn, false);
  assert.equal(b.dischargeFetOn, true);
  assert.equal(transport.device.writesSaved, 0, 'ключи не сохраняются в память платы');
  await client.close();
});

test('остаток ёмкости устанавливается и читается обратно', async () => {
  const transport = createFakeTransport({ latencyMs: 1 });
  const client = new BmsClient(transport, { timeoutMs: 300, retries: 0 });
  await client.writeSettings([{ reg: CTRL_REG.CAP_REM, raw: capRemRaw(55.5) }], { save: false });
  const b = await client.readBasicInfo();
  assert.ok(Math.abs(b.remainingAh - 55.5) < 0.05);
  await client.close();
});

test('сброс счётчиков: выход с сохранением обнуляет ошибки', async () => {
  const transport = createFakeTransport({ latencyMs: 1 });
  transport.device.errorCounts = [1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0];
  const client = new BmsClient(transport, { timeoutMs: 300, retries: 0 });
  await client.writeSettings([], { save: true });
  const e = await client.readErrorCounters();
  assert.ok(Object.values(e).every((v) => v === 0));
  await client.close();
});
