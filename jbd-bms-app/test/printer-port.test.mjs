// Порт чекового принтера — не порт платы.
//
// Если приложение опрашивает порт принтера как BMS (поиск плат, автоподключение,
// ежесекундный опрос банка), в принтер уходят кадры dd a5 03 00 ff fd 77:
// байты ≥ 0x80 принтер печатает иероглифами, а сам порт остаётся занятым, и чек
// не печатается вовсе. Эти тесты фиксируют, что принтер вне зоны опроса BMS.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer, banks } from '../scripts/server.mjs';
import { PrinterService } from '../scripts/printer-service.mjs';

const PRINTER_PATH = '/dev/ttyPRINTER0';

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
});

after(async () => {
  await post('/api/disconnect', {}).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
});

test('настройка принтера помечает его порт: он не опрашивается как плата', async () => {
  const cfg = await post('/api/printer/config', { path: PRINTER_PATH, baudRate: 9600, width: 32 });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.data));
  assert.equal(cfg.data.path, PRINTER_PATH);

  const ports = await get('/api/ports');
  assert.equal(ports.data.printerPath, PRINTER_PATH, 'принтер отмечен в списке портов');
  for (const p of ports.data.ports) {
    if (p.path === PRINTER_PATH) assert.equal(p.printer, true, 'порт принтера помечен флагом printer');
  }

  // поиск плат не шлёт в принтер кадры dd a5 03 … — они печатаются иероглифами
  const scan = await post('/api/scan', {});
  assert.equal(scan.status, 200, JSON.stringify(scan.data));
  assert.ok(scan.data.skipped.includes(PRINTER_PATH), 'порт принтера пропущен при поиске плат');
  assert.ok(!scan.data.results.some((r) => r.path === PRINTER_PATH), 'принтер не опрашивался');
});

test('порт принтера нельзя занять под плату — ни вручную, ни автоподключением', async () => {
  await post('/api/printer/config', { path: PRINTER_PATH });

  const add = await post('/api/banks/add', { path: PRINTER_PATH });
  assert.equal(add.status, 409, JSON.stringify(add.data));
  assert.equal(add.data.error, 'PORT_IS_PRINTER');
  assert.match(add.data.message ?? '', /принтер/i);

  const auto = await post('/api/banks/auto', {});
  assert.equal(auto.status, 200, JSON.stringify(auto.data));
  const banks = (await get('/api/banks')).data.banks;
  assert.ok(!banks.some((b) => b.path === PRINTER_PATH), 'принтер не стал банком');
});

test('порт отдали принтеру — банк, висевший на этом порту, отключается', async () => {
  const demo = await post('/api/banks/demo', { count: 1 });
  assert.equal(demo.status, 200, JSON.stringify(demo.data));
  const before = (await get('/api/banks')).data.banks;
  assert.equal(before.length, 1);
  const port = before[0].path;

  const cfg = await post('/api/printer/config', { path: port });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.data));
  assert.equal(cfg.data.freedPort, port, 'сервер сообщил, что порт освобождён от банка');

  const after = (await get('/api/banks')).data.banks;
  assert.ok(!after.some((b) => b.path === port), 'банк на порту принтера отключён — опрос не мешает чеку');
});

test('печать в порт, занятый платой, запрещена: опрос не перемешивается с чеком', async () => {
  const svc = new PrinterService({ isPortBusy: (p) => p === '/dev/ttyBMS0' });
  svc.configure({ path: '/dev/ttyBMS0' });
  await assert.rejects(
    () => svc.testPage(),
    (e) => e.code === 'PORT_BUSY' && /занят платой/.test(e.message),
    'печать в порт платы не начинается',
  );
  // свободный порт печатает как обычно
  const free = new PrinterService({ isPortBusy: () => false });
  free.configure({ path: '/dev/ttyBMS1' });
  await assert.rejects(() => free.testPage(), (e) => e.code === 'PRINT_FAILED', 'порт просто недоступен — не PORT_BUSY');
  assert.equal(svc.status().busy, true, 'статус показывает: порт принтера занят платой');
  assert.equal(free.status().busy, false);
});

test('старое состояние: плата висит на порту принтера — статус «занят», повторный выбор порта лечит', async () => {
  const port = '/dev/ttyPRINTER1';
  await post('/api/printer/config', { path: port });
  // банк на порту принтера: так бывало после «Найти и подключить все» до правки
  const bank = await banks.add({ path: port, demo: true, label: 'старая плата' });
  assert.equal(bank.path, port);

  const busyState = await get('/api/printer');
  assert.equal(busyState.data.busy, true, 'статус предупреждает, что порт занят платой');

  const again = await post('/api/printer/config', { path: port });
  assert.equal(again.data.freedPort, port, 'повторный выбор порта отключает мешающий банк');
  assert.equal((await get('/api/printer')).data.busy, false);
  assert.ok(!(await get('/api/banks')).data.banks.some((b) => b.path === port), 'банк на порту принтера отключён');
});
