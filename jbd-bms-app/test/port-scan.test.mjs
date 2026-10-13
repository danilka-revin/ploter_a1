// Поиск батареи по портам: эмулятор платы отвечает, «занятый» порт и «немой» адаптер —
// нет. Настоящие порты не открываются: подменяем способ открытия.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanBmsPorts } from '../scripts/port-scan.mjs';
import { createFakeTransport } from '../scripts/fake-bms.mjs';

test('батарея найдена на нужном порту, остальные отмечены понятной причиной', async () => {
  const ports = [
    { path: '/dev/ttyUSB0', label: 'адаптер без платы' },
    { path: '/dev/ttyUSB1', label: 'плата BMS' },
    { path: '/dev/ttyUSB2', label: 'занятый порт' },
  ];
  const open = async (path) => {
    if (path === '/dev/ttyUSB2') throw new Error(`не удалось открыть ${path}: Permission denied`);
    if (path === '/dev/ttyUSB0') {
      // адаптер есть, но на другом конце ничего нет: сохраняем транспорт без эмулятора
      return { async write() {}, onData() {}, async close() {} };
    }
    return createFakeTransport({ latencyMs: 1, cellCount: 12, name: 'SCAN TEST 12S' });
  };
  const results = await scanBmsPorts(ports, { open });
  assert.equal(results.length, 3);

  const [silent, bms, busy] = results;
  assert.equal(silent.found, false);
  assert.equal(silent.reason, 'silent');

  assert.equal(bms.found, true);
  assert.equal(bms.cellCount, 12);
  assert.equal(bms.deviceName, 'SCAN TEST 12S');
  assert.equal(bms.label, 'плата BMS');

  assert.equal(busy.found, false);
  assert.equal(busy.reason, 'busy');
  assert.match(busy.detail, /Permission denied/);
});

test('пустой список портов — пустой результат, без ошибок', async () => {
  assert.deepEqual(await scanBmsPorts([]), []);
});

test('порт, который не отвечает, закрывается после опроса', async () => {
  let closed = false;
  const open = async () => ({
    async write() {},
    onData() {},
    async close() { closed = true; },
  });
  const [r] = await scanBmsPorts([{ path: '/dev/ttyUSB9' }], { open });
  assert.equal(r.found, false);
  assert.equal(closed, true, 'порт должен закрываться даже без ответа');
});
