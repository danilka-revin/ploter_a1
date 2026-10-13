// Менеджер банков: несколько плат одновременно, история для графиков, отчёт и защита записи.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BankManager, cellStats } from '../scripts/banks.mjs';
import { createFakeTransport } from '../scripts/fake-bms.mjs';

function manager() {
  return new BankManager({ pollMs: 50, openTransport: async () => createFakeTransport({ latencyMs: 1 }) });
}

test('два банка живут независимо и попадают в один отчёт', async () => {
  const mgr = manager();
  const a = await mgr.add({ path: '/dev/ttyUSB0', label: 'BANK A' });
  const b = await mgr.add({ path: '/dev/ttyUSB1', label: 'BANK B' });
  assert.notEqual(a.id, b.id);
  await mgr.pollAll();
  const rows = mgr.list().map((x) => mgr.row(x));
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.connected, true);
    assert.ok(r.voltage > 10, 'напряжение прочитано');
    assert.equal(r.cells.length, 12);
    assert.ok(r.stats.delta >= 0);
  }
  const fleet = mgr.fleet();
  assert.equal(fleet.banks, 2);
  assert.equal(fleet.online, 2);
  assert.ok(Math.abs(fleet.currentSum - (rows[0].current + rows[1].current)) < 0.05, 'ток парка = сумма токов');
  assert.ok(fleet.powerSum !== null);
  assert.equal(fleet.stale, 0);
  await mgr.removeAll();
});

test('ряды для графиков и агрегат парка: длина совпадает, окна прореживаются', async () => {
  const mgr = manager();
  const bank = await mgr.add({ path: '/dev/ttyUSB0', label: 'A' });
  await mgr.add({ path: '/dev/ttyUSB1', label: 'B' });
  for (let i = 0; i < 12; i++) await mgr.pollAll();
  const series = mgr.series(bank, { seconds: 3600, points: 6 });
  assert.ok(series.t.length >= 2);
  assert.equal(series.t.length, series.v.length);
  assert.equal(series.t.length, series.temps[0].length);
  assert.ok(series.samples >= 12);
  const fleet = mgr.fleetSeries({ seconds: 3600, points: 60 });
  assert.ok(fleet.t.length >= 2, 'агрегат по парку построен');
  assert.ok(Number.isFinite(fleet.a.at(-1)), 'суммарный ток — число');
  const panel = mgr.panel({ focus: bank.id, seconds: 600 });
  assert.equal(panel.focus, bank.id);
  assert.equal(panel.banks.length, 2);
  assert.ok(panel.series.t.length >= 2);
  await mgr.removeAll();
});

test('статистика ячеек: минимум, максимум, разброс, сумма', () => {
  const st = cellStats([3300, 3320, 3280]);
  assert.deepEqual({ min: st.min, max: st.max, delta: st.delta, avg: st.avg, minIndex: st.minIndex, maxIndex: st.maxIndex, sum: st.sum },
    { min: 3280, max: 3320, delta: 40, avg: 3300, minIndex: 2, maxIndex: 1, sum: 9900 });
  assert.equal(cellStats([]), null);
});

test('запись настроек: подтверждение, пределы и «рискованные» регистры', async () => {
  const mgr = manager();
  const bank = await mgr.add({ path: '/dev/ttyUSB0', label: 'A' });
  await assert.rejects(() => mgr.writeSettings(bank.id, { changes: { covp: 3600 } }), /не подтверждена/i);
  await assert.rejects(() => mgr.writeSettings(bank.id, { confirm: true, changes: { covp: 9000 } }), /допустимо от/i);
  await assert.rejects(
    () => mgr.writeSettings(bank.id, { confirm: true, changes: { func_mask: 0 } }),
    /риск/i, 'маска функций требует подтверждения риска',
  );
  await assert.rejects(
    () => mgr.writeSettings(bank.id, { confirm: true, changes: { covp: 2600, cuvp: 2700 } }),
    /перенапряжение ячейки должно быть выше/i, 'связи порогов проверяются',
  );
  const ok = await mgr.writeSettings(bank.id, { confirm: true, changes: { covp: 3600, soc_50: 3375 }, risk: true });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(ok.changed, 2);
  const after = await mgr.readSettings(bank.id);
  assert.equal(after.values.covp, 3600);
  assert.equal(after.values.soc_50, 3375);
  await mgr.removeAll();
});

test('байтовые поля пишутся по одному байту, второй остаётся прежним', async () => {
  const mgr = manager();
  const bank = await mgr.add({ path: '/dev/ttyUSB0', label: 'A' });
  const before = await mgr.readSettings(bank.id);
  const rel = before.values.chg_oc_rel;
  const res = await mgr.writeSettings(bank.id, { confirm: true, changes: { chg_oc_delay: 12 }, risk: true });
  assert.equal(res.ok, true, res.message);
  const after = await mgr.readSettings(bank.id);
  assert.equal(after.values.chg_oc_delay, 12);
  assert.equal(after.values.chg_oc_rel, rel, 'младший байт не изменился');
  await mgr.removeAll();
});

test('команды управления: ключи можно отдать всем банкам сразу', async () => {
  const mgr = manager();
  const a = await mgr.add({ path: '/dev/ttyUSB0', label: 'A' });
  const b = await mgr.add({ path: '/dev/ttyUSB1', label: 'B' });
  const r = await mgr.control('all', 'fet', { charge: false, discharge: true, confirm: true, all: true });
  assert.equal(r.results.length, 2);
  assert.ok(r.ok, JSON.stringify(r.results));
  for (const id of [a.id, b.id]) {
    const row = mgr.row(mgr.get(id));
    assert.equal(row.chargeFetOn, false, `${id}: заряд выключен`);
    assert.equal(row.dischargeFetOn, true, `${id}: разряд включён`);
  }
  await assert.rejects(() => mgr.control(a.id, 'nope', { confirm: true }), /Неизвестная команда/);
  await assert.rejects(() => mgr.control(a.id, 'soft-reset', { confirm: true }), /подтвердите риск/i);
  await mgr.removeAll();
});

test('остаток ёмкости и балансировка применяются к банку', async () => {
  const mgr = manager();
  const bank = await mgr.add({ path: '/dev/ttyUSB0', label: 'A' });
  const cap = await mgr.control(bank.id, 'capacity', { ah: 55.5, confirm: true });
  assert.equal(cap.results[0].ok, true);
  assert.ok(Math.abs(cap.results[0].remainingAh - 55.5) < 0.05);
  const bal = await mgr.control(bank.id, 'balance', { on: false, confirm: true });
  assert.equal(bal.results[0].ok, true);
  assert.equal(bank.transport.device.balanceOn, false, 'плата приняла запрет балансировки');
  await mgr.removeAll();
});

test('сырая консоль: чтение отвечает, запись без подтверждения отклоняется, опасный регистр требует risk', async () => {
  const mgr = manager();
  const bank = await mgr.add({ path: '/dev/ttyUSB0', label: 'A' });
  const read = await mgr.rawRead(bank.id, [0x03, 0x04, 0xaa, 0xff]);
  assert.equal(read.items.length, 4);
  assert.equal(read.items[0].ok, true);
  assert.ok(read.items[1].bytes.length >= 24, 'ячейки пришли байтами');
  assert.equal(read.items[3].ok, false, 'несуществующий регистр — ошибка, а не падение');
  await assert.rejects(() => mgr.rawWrite(bank.id, { reg: 0x24, raw: 3600 }), /не подтверждена/i);
  await assert.rejects(() => mgr.rawWrite(bank.id, { reg: 0xe3, raw: 0x4321, confirm: true }), /опасн/i, 'сброс платы требует подтверждения риска');
  const w = await mgr.rawWrite(bank.id, { reg: 0x24, raw: 3600, confirm: true });
  assert.equal(w.ok, true, w.message);
  assert.equal(w.read.u16, 3600, 'значение прочиталось обратно');
  await mgr.removeAll();
});

test('отчёт и CSV содержат все банки и все читаемые регистры', async () => {
  const mgr = manager();
  const a = await mgr.add({ path: '/dev/ttyUSB0', label: 'BANK A' });
  await mgr.add({ path: '/dev/ttyUSB1', label: 'BANK B' });
  await mgr.pollAll();
  const report = await mgr.report({});
  assert.equal(report.banks.length, 2);
  assert.ok(report.banks[0].settings.length > 40, 'в отчёте все регистры EEPROM');
  assert.equal(report.banks[0].info.sw_version, 'SW 4.21-LFP');
  const csv = mgr.csv();
  const lines = csv.split('\r\n');
  assert.match(lines[0], /Напряжение В/);
  assert.equal(lines.filter((l) => /BANK [AB]/.test(l)).length >= 2, true);
  assert.match(csv, /Таблица SOC|0x44|Функции платы/, 'в CSV есть дополнительные регистры');
  const single = await mgr.report({ id: a.id, settings: false });
  assert.equal(single.banks.length, 1);
  await mgr.removeAll();
});

test('потеря связи: три ошибки подряд — банк помечается offline, другие продолжают опрашиваться', async () => {
  const mgr = manager();
  const a = await mgr.add({ path: '/dev/ttyUSB0', label: 'A' });
  const b = await mgr.add({ path: '/dev/ttyUSB1', label: 'B' });
  a.transport.write = async () => { throw new Error('порт отвалился'); };
  a.client.transport.write = a.transport.write;
  for (let i = 0; i < 3; i++) await mgr.pollAll().catch(() => {});
  assert.equal(a.connected, false);
  assert.ok(a.lastError.length > 0);
  assert.equal(b.connected, true, 'второй банк жив');
  assert.equal(mgr.fleet().stale, 1);
  await mgr.removeAll();
});

test('автоподключение: берём только порты, где плата ответила', async () => {
  const mgr = manager();
  const r = await mgr.autoConnect({
    ports: [{ path: '/dev/ttyUSB0' }, { path: '/dev/ttyUSB1' }],
    results: [
      { path: '/dev/ttyUSB0', found: true, deviceName: 'JBD', cellCount: 12 },
      { path: '/dev/ttyUSB1', found: false, reason: 'silent' },
    ],
  });
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].path, '/dev/ttyUSB0');
  assert.equal(mgr.list().length, 1);
  await mgr.removeAll();
});

test('переименование банка используется в отчёте и командах', async () => {
  const mgr = manager();
  const bank = await mgr.add({ path: '/dev/ttyUSB0' });
  mgr.rename(bank.id, 'Гараж · 12S');
  assert.equal(mgr.row(bank).label, 'Гараж · 12S');
  const r = await mgr.control(bank.id, 'clear-errors', { confirm: true });
  assert.equal(r.results[0].label, 'Гараж · 12S');
  await mgr.removeAll();
});
