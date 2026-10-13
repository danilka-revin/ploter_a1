// Запись настроек: пределы, связи порогов, заводской режим и проверка на эмуляторе платы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS, checkSettingValue, checkSettingsConsistency, settingToRaw, writableDefs,
} from '../scripts/jbd-protocol.mjs';
import { BmsClient } from '../scripts/bms-client.mjs';
import { createFakeTransport } from '../scripts/fake-bms.mjs';

const def = (key) => SETTINGS.find((d) => d.key === key);

test('пределы: допустимые значения принимаются, выход за пределы и не тот шаг — отклоняются', () => {
  assert.equal(checkSettingValue('covp', 3650), null);
  assert.match(checkSettingValue('covp', 5000), /допустимо от 2500 до 4250/);
  assert.match(checkSettingValue('povp', 43805), /шаг регистра/);
  assert.equal(checkSettingValue('povp', 43800), null);
  assert.match(checkSettingValue('chgot', 45.33), /шаг регистра/);
  assert.match(checkSettingValue('covp', 'abc'), /введите число/);
  assert.match(checkSettingValue('cell_cnt', 12), /нельзя записать/, 'число ячеек не записывается');
});

test('записываемые параметры описаны и не содержат cell_cnt', () => {
  const keys = writableDefs().map((d) => d.key);
  assert.ok(keys.includes('design_cap'));
  assert.ok(keys.includes('chgoc') && keys.includes('dsgoc'));
  assert.ok(!keys.includes('cell_cnt'));
});

test('raw-значения регистров: мВ с шагом 10, мА ×10, температура со смещением 2731', () => {
  assert.equal(settingToRaw(def('povp'), 43800), 4380);
  assert.equal(settingToRaw(def('chgoc'), 40000), 4000);
  assert.equal(settingToRaw(def('design_cap'), 100000), 10000);
  assert.equal(settingToRaw(def('chgot'), 45.3), 3184);
  assert.equal(settingToRaw(def('dsgut'), -20), 2531);
});

test('связи порогов: возврат выше срабатывания ловится', () => {
  assert.deepEqual(checkSettingsConsistency({ covp: 3650, covp_rel: 3350 }), []);
  const errs = checkSettingsConsistency({ covp: 3650, covp_rel: 3700 });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /выше возврата/);
  assert.match(checkSettingsConsistency({ cuvp: 2900, cuvp_rel: 2500 })[0], /порога/);
});

test('полный цикл: пароль → заводской режим → запись → сохранение → выход; значения читаются обратно', async () => {
  const transport = createFakeTransport({ latencyMs: 1 });
  const client = new BmsClient(transport, { timeoutMs: 300, retries: 0 });
  const dev = transport.device;

  const entries = [
    { reg: def('covp').reg, raw: settingToRaw(def('covp'), 3600) },
    { reg: def('chgoc').reg, raw: settingToRaw(def('chgoc'), 50000) },
  ];
  const res = await client.writeSettings(entries, { save: true, password: '' });
  assert.deepEqual(res, { written: 2, saved: true });
  assert.equal(dev.factory, false, 'после записи заводской режим выключен');
  assert.equal(dev.writesSaved, 1, 'выход с сохранением в память платы');

  assert.equal(await client.readRaw(def('covp')), settingToRaw(def('covp'), 3600));
  assert.equal(await client.readRaw(def('chgoc')), settingToRaw(def('chgoc'), 50000));
  await client.close();
});

test('без сохранения: выход 00 00, в память платы ничего не записано', async () => {
  const transport = createFakeTransport({ latencyMs: 1 });
  const client = new BmsClient(transport, { timeoutMs: 300, retries: 0 });
  const res = await client.writeSettings([{ reg: def('covp').reg, raw: settingToRaw(def('covp'), 3620) }], { save: false });
  assert.deepEqual(res, { written: 1, saved: false });
  assert.equal(transport.device.writesSaved, 0);
  assert.equal(transport.device.factory, false);
  await client.close();
});

test('неверный пароль: запись не начинается, плата не меняется', async () => {
  const transport = createFakeTransport({ latencyMs: 1, password: '123456' });
  const client = new BmsClient(transport, { timeoutMs: 300, retries: 0 });
  await assert.rejects(
    client.writeSettings([{ reg: def('covp').reg, raw: settingToRaw(def('covp'), 3600) }], { password: 'wrong1' }),
    /пароль/,
  );
  assert.equal(transport.device.factory, false);
  assert.equal(await client.readRaw(def('covp')), settingToRaw(def('covp'), 3650));
  await client.close();
});

test('правильный пароль из шести символов открывает запись', async () => {
  const transport = createFakeTransport({ latencyMs: 1, password: '123456' });
  const client = new BmsClient(transport, { timeoutMs: 300, retries: 0 });
  await client.writeSettings([{ reg: def('covp').reg, raw: settingToRaw(def('covp'), 3600) }], { password: '123456' });
  assert.equal(await client.readRaw(def('covp')), settingToRaw(def('covp'), 3600));
  await client.close();
});

test('запись вне заводского режима отклоняется платой', async () => {
  const transport = createFakeTransport({ latencyMs: 1 });
  const client = new BmsClient(transport, { timeoutMs: 300, retries: 0 });
  await assert.rejects(client.write(def('covp').reg, [0x0e, 0x10]), /отклонил/);
  assert.equal(await client.readRaw(def('covp')), settingToRaw(def('covp'), 3650));
  await client.close();
});

test('сбой в середине записи: выход из заводского режима без сохранения', async () => {
  const transport = createFakeTransport({ latencyMs: 1 });
  const client = new BmsClient(transport, { timeoutMs: 300, retries: 0 });
  const dev = transport.device;
  await assert.rejects(
    client.writeSettings([
      { reg: def('covp').reg, raw: settingToRaw(def('covp'), 3600) },
      { reg: 0x7f, raw: 1 }, // неизвестный регистр — плата отвечает ошибкой
    ]),
    /отклонил/,
  );
  assert.equal(dev.factory, false, 'заводской режим закрыт');
  assert.equal(dev.writesSaved, 0, 'частичная запись не сохранена в память');
  await client.close();
});
