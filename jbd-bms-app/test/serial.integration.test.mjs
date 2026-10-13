// Интеграция с настоящим последовательным портом: socat создаёт пару
// виртуальных портов (как USB-UART адаптер и провод к BMS), на одном конце
// работает эмулятор BMS, на другом — наш транспорт serialport + BmsClient.
// Если socat не установлен, тест пропускается (sudo apt install socat).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SerialPort } from 'serialport';
import { openSerialTransport, listSerialPorts } from '../scripts/serial-transport.mjs';
import { BmsClient } from '../scripts/bms-client.mjs';
import { FakeBmsDevice } from '../scripts/fake-bms.mjs';
import { SETTINGS } from '../scripts/jbd-protocol.mjs';

const HAS_SOCAT = spawnSync('which', ['socat']).status === 0;
const skip = HAS_SOCAT ? false : 'socat не установлен';

let dir;
let socat;
let bmsEnd;   // путь к «плате» (эмулятор)
let hostEnd;  // путь к «компьютеру» (наше приложение)
let emulator;

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'jbd-serial-'));
  const a = join(dir, 'bms');
  const b = join(dir, 'host');
  socat = spawn('socat', [
    '-d', '-d',
    `pty,raw,echo=0,link=${a}`,
    `pty,raw,echo=0,link=${b}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  // ждём, пока socat создаст ссылки на pty
  for (let i = 0; i < 100 && !(existsSync(a) && existsSync(b)); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  bmsEnd = a;
  hostEnd = b;

  // эмулятор подключаем к «плате» через тот же serialport, что и приложение
  const device = new FakeBmsDevice({ cellCount: 4, name: 'SERIAL DEMO' });
  emulator = await new Promise((resolve, reject) => {
    const port = new SerialPort({ path: bmsEnd, baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', autoOpen: false });
    port.open((err) => {
      if (err) return reject(err);
      port.on('data', (chunk) => {
        const reply = device.receive(chunk);
        if (reply.length) port.write(reply);
      });
      resolve(port);
    });
  });
});

after(async () => {
  if (emulator && emulator.isOpen) await new Promise((r) => emulator.close(() => r()));
  if (socat) socat.kill('SIGTERM');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('список портов не падает и возвращает массив', { skip }, async () => {
  const ports = await listSerialPorts();
  assert.ok(Array.isArray(ports));
});

test('чтение базовой информации, ячеек, имени и настроек через настоящий порт', { skip }, async () => {
  const transport = await openSerialTransport(hostEnd, { baudRate: 9600 });
  const client = new BmsClient(transport, { timeoutMs: 1000, retries: 2 });
  try {
    const basic = await client.readBasicInfo();
    assert.equal(basic.cellCount, 4);
    const cells = await client.readCellInfo();
    assert.equal(cells.length, 4);
    assert.equal(await client.readDeviceName(), 'SERIAL DEMO');
    const covp = SETTINGS.find((s) => s.key === 'covp');
    assert.equal(await client.readSetting(covp), 3650);
    const errors = await client.readErrorCounters();
    assert.equal(errors.sc, 0);
  } finally {
    await client.close();
  }
});

test('несколько подряд опросов не теряют синхронизацию', { skip }, async () => {
  const transport = await openSerialTransport(hostEnd, { baudRate: 9600 });
  const client = new BmsClient(transport, { timeoutMs: 1000, retries: 2 });
  try {
    for (let i = 0; i < 10; i++) {
      const cells = await client.readCellInfo();
      assert.equal(cells.length, 4);
    }
  } finally {
    await client.close();
  }
});

test('порт, которого нет, даёт понятную ошибку', { skip }, async () => {
  await assert.rejects(openSerialTransport('/dev/ttyNOPE-jbd'), /не удалось открыть/);
});


test('поиск батареи находит плату на настоящем порту и не трогает пустой', { skip }, async () => {
  const { scanBmsPorts } = await import('../scripts/port-scan.mjs');
  const missing = join(dir, 'nothing-here');
  const results = await scanBmsPorts([
    { path: missing, label: 'нет такого порта' },
    { path: hostEnd, label: 'плата' },
  ]);
  assert.equal(results[0].found, false);
  assert.equal(results[0].reason, 'busy');
  assert.equal(results[1].found, true, results[1].detail);
  assert.equal(results[1].cellCount, 4);
  assert.equal(results[1].deviceName, 'SERIAL DEMO');
});
