// HTTP API панели: банки, графики, отчёт и запись настроек через реальный сервер.
// Платы нет — используются эмуляторы (демо-банки).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../scripts/server.mjs';

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
  const r = await post('/api/banks/demo', { count: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (let i = 0; i < 80; i++) {
    const p = await get('/api/panel');
    const ready = p.data.banks.length === 3
      && p.data.banks.every((b) => b.voltage !== null && b.cells.length > 0)
      && p.data.series.t.length > 1;
    if (ready) break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
});

after(async () => {
  await post('/api/disconnect', {});
  await new Promise((resolve) => server.close(resolve));
});

test('панель отдаёт строки всех банков, итоги парка и ряды графиков', async () => {
  const { status, data } = await get('/api/panel?window=300');
  assert.equal(status, 200);
  assert.equal(data.banks.length, 3);
  assert.equal(data.fleet.banks, 3);
  assert.equal(data.fleet.online, 3);
  assert.ok(data.banks.every((b) => b.voltage > 10 && b.cells.length > 0));
  assert.ok(data.banks[0].spark.length > 0, 'мини-график для строки');
  assert.ok(data.series.t.length > 1, 'ряды для графиков есть');
  assert.ok(data.series.v.length === data.series.t.length);
  assert.ok(data.fleetSeries, 'агрегат по парку');
  assert.ok(Array.isArray(data.fleetSeries.temps[0]));
});

test('каталог описывает все регистры: чтение, запись и команды', async () => {
  const { data } = await get('/api/catalog');
  assert.ok(data.settings.length >= 55, `настроек описано: ${data.settings.length}`);
  assert.ok(data.writable.length >= 50, 'записываемых параметров большинство');
  assert.ok(data.settings.some((s) => s.key === 'soc_50' && s.editable), 'таблица SOC доступна для записи');
  assert.ok(data.settings.some((s) => s.key === 'chg_oc_delay' && s.byte === 'hi'), 'байтовые поля помечены');
  assert.ok(data.settings.some((s) => s.key === 'func_mask' && s.risky), 'маски помечены как рискованные');
  assert.ok(data.settings.some((s) => s.key === 'cell_cnt' && !s.editable), 'число ячеек не меняется');
  assert.ok(data.regs.length > 80, 'каталог регистров полный');
  assert.ok(data.info.some((i) => i.key === 'sw_version'), 'паспорт платы описан');
  assert.ok(data.control.some((c) => c.key === 'balance' && c.risky), 'балансировка — непроверенная команда');
});

test('регистры банка: паспорт, базовая информация и все пороги сразу', async () => {
  const banks = (await get('/api/banks')).data.banks;
  const { data } = await get(`/api/bank/registers?id=${banks[0].id}`);
  assert.equal(data.settings.length, (await get('/api/catalog')).data.settings.length);
  assert.equal(data.info.sw_version, 'SW 4.21-LFP');
  assert.equal(data.info.model_name, 'JBD-SP14S004');
  assert.match(data.info.prod_date, /2024/);
  assert.ok(data.basic.cellCount >= 8);
  assert.ok(data.settings.every((s) => s.reg && s.label));
  assert.ok(data.settings.some((s) => s.key === 'life_cap' && s.value > 0), 'ёмкость за срок службы прочитана');
});

test('запись настроек: без подтверждения отказ, с подтверждением — значение меняется', async () => {
  const id = (await get('/api/banks')).data.banks[0].id;
  const bad = await post('/api/bank/settings/write', { id, changes: { covp: 3600 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'NOT_CONFIRMED');
  const range = await post('/api/bank/settings/write', { id, confirm: true, changes: { covp: 9000 } });
  assert.equal(range.status, 400);
  assert.match(range.data.message, /допустимо от 2500 до 4250/);
  const risk = await post('/api/bank/settings/write', { id, confirm: true, changes: { func_mask: 0 } });
  assert.equal(risk.status, 400);
  assert.equal(risk.data.error, 'RISK_NOT_CONFIRMED');
  const ok = await post('/api/bank/settings/write', { id, confirm: true, changes: { covp: 3611 }, risk: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.changed, 1);
  assert.equal(ok.data.items[0].actual, 3611, 'значение перечитано с платы');
});

test('таблица SOC защищена связностью: 90 % не может быть ниже 80 %', async () => {
  const id = (await get('/api/banks')).data.banks[1].id;
  const r = await post('/api/bank/settings/write', { id, confirm: true, changes: { soc_90: 3000 } });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'INCONSISTENT');
  assert.match(r.data.message, /90 % должно быть выше 80 %/);
});

test('команды: ключи банку и всем банкам сразу, отказ для неизвестной команды', async () => {
  const one = (await get('/api/banks')).data.banks[0].id;
  const r = await post('/api/bank/control', { id: one, action: 'fet', charge: false, discharge: true, confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.results[0].chargeFetOn, false);
  const all = await post('/api/bank/control', { id: 'all', action: 'fet', charge: true, discharge: true, confirm: true, all: true });
  assert.equal(all.data.results.length, 3);
  assert.ok(all.data.ok);
  const after = await get('/api/banks');
  assert.ok(after.data.banks.every((b) => b.chargeFetOn === true));
  const bad = await post('/api/bank/control', { id: one, action: 'explode', confirm: true });
  assert.equal(bad.status, 400);
  const risky = await post('/api/bank/control', { id: one, action: 'soft-reset', confirm: true });
  assert.equal(risky.status, 400);
  assert.equal(risky.data.error, 'RISK_NOT_CONFIRMED');
});

test('консоль регистров: чтение пачкой и запись одного регистра', async () => {
  const id = (await get('/api/banks')).data.banks[0].id;
  const read = await post('/api/bank/raw/read', { id, regs: [0x03, 0x04, 0x05, 0xff] });
  assert.equal(read.status, 200);
  assert.equal(read.data.items.length, 4);
  assert.equal(read.data.items[0].ok, true);
  assert.equal(read.data.items[2].text.length > 3, true, 'имя устройства как текст');
  assert.equal(read.data.items[3].ok, false, '0xFF не отвечает');
  const write = await post('/api/bank/raw/write', { id, reg: 0x24, raw: 3620, confirm: true });
  assert.equal(write.status, 200, JSON.stringify(write.data));
  assert.equal(write.data.read.u16, 3620);
  const danger = await post('/api/bank/raw/write', { id, reg: 0xe3, raw: 0x4321, confirm: true });
  assert.equal(danger.status, 400, 'опасный регистр без risk не пишется');
});

test('отчёт по всем банкам: JSON и CSV', async () => {
  const { data } = await get('/api/report');
  assert.equal(data.banks.length, 3);
  assert.ok(data.banks[0].settings.length > 50);
  assert.ok(data.fleet.banks === 3);
  const csv = await fetch(`${base}/api/report.csv`).then((r) => r.text());
  assert.match(csv, /Банк;Порт;/);
  assert.match(csv, /ДЕМО A/);
  assert.match(csv, /ДЕМО C/);
  assert.match(csv, /Настройки; /);
  assert.ok(csv.split('\r\n').length > 60, 'в CSV есть блоки настроек по каждому банку');
});

test('период опроса меняется, старый адрес /api/snapshot жив', async () => {
  const set = await post('/api/poll', { ms: 2000 });
  assert.equal(set.data.pollMs, 2000);
  const back = await post('/api/poll', { ms: 1000 });
  assert.equal(back.data.pollMs, 1000);
  const snap = await get('/api/snapshot');
  assert.equal(snap.status, 200);
  assert.ok(snap.data.basic.packVoltage > 10);
  assert.ok(snap.data.cells.values.length > 0);
  const state = await get('/api/state');
  assert.equal(state.data.connected, true);
  assert.equal(state.data.banks, 3);
});

test('резервная копия и восстановление: файл читается, изменения считаются', async () => {
  const id = (await get('/api/banks')).data.banks[2].id;
  const copy = await get(`/api/backup?id=${id}`);
  assert.equal(copy.status, 200);
  assert.ok(copy.data.items.covp > 2500);
  assert.ok(copy.data.items.soc_50, 'дополнительные регистры тоже в копии');
  const file = { ...copy.data, items: { ...copy.data.items, covp: 3640 } };
  const dry = await post('/api/backup/restore', { id, file, dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.changes.length, 1);
  const real = await post('/api/backup/restore', { id, file, dryRun: false, confirm: true, risk: true, save: true });
  assert.equal(real.status, 200, JSON.stringify(real.data));
  const after = await get(`/api/bank/settings?id=${id}`);
  assert.equal(after.data.items.find((i) => i.key === 'covp').value, 3640);
});

test('чековый принтер: предпросмотр чека на английском (ASCII), без порта печать не начинается', async () => {
  const st = await get('/api/printer');
  assert.equal(st.status, 200);
  assert.equal(st.data.language, 'en');
  assert.equal('charPage' in st.data, false, 'кодовой страницы больше нет — печатается только ASCII');

  const ascii = (lines, width) => lines.every((l) => /^[\x20-\x7e]*$/.test(l) && l.length <= width);
  const fleet = await get('/api/printer/preview?id=all');
  assert.equal(fleet.status, 200, JSON.stringify(fleet.data));
  assert.equal(fleet.data.kind, 'fleet');
  assert.ok(ascii(fleet.data.lines, fleet.data.width), fleet.data.lines.join('\n'));
  const fleetText = fleet.data.lines.join('\n');
  assert.match(fleetText, /A L L {3}B A T T E R I E S/);
  assert.match(fleetText, /DEMO A - online/, 'подпись «ДЕМО A» напечатается латиницей');
  assert.doesNotMatch(fleetText, /[А-Яа-яЁё]/);

  const id = (await get('/api/banks')).data.banks[0].id;
  const one = await get(`/api/printer/preview?id=${id}`);
  assert.equal(one.data.kind, 'bank');
  assert.ok(ascii(one.data.lines, one.data.width));
  assert.match(one.data.lines.join('\n'), /^Voltage +\d+\.\d\d V$/m);

  const testPage = await get('/api/printer/preview?id=test');
  assert.match(testPage.data.lines.join('\n'), /PRINTER TEST/);
  assert.equal((await get('/api/printer/preview?id=nope')).status, 404);

  const noPort = await post('/api/printer/print', { id });
  assert.equal(noPort.status, 400);
  assert.equal(noPort.data.error, 'NO_PRINTER');
});
