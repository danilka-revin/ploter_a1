#!/usr/bin/env node
// Локальный сервер JBD BMS: отдаёт интерфейс и API к плате по UART.
//
//   node scripts/server.mjs [порт]
//   node scripts/server.mjs --update-now   — проверить GitHub и обновиться (для run.sh)
//
// По умолчанию слушает только 127.0.0.1 (порт 8585): плата подключена к этому
// компьютеру, наружу её открывать не нужно. Переменные окружения:
//   BMS_APP_HOST  — адрес (по умолчанию 127.0.0.1)
//   BMS_APP_PORT  — порт (по умолчанию 8585)
//
// API:
//   GET  /healthz            — жив ли сервер и его версия
//   GET  /api/ports          — последовательные порты (и пункт «demo» — без платы)
//   POST /api/connect        — { path } открыть порт и проверить связь с BMS
//   POST /api/disconnect     — закрыть порт
//   GET  /api/snapshot       — состояние батареи, ячейки, счётчики ошибок
//   GET  /api/settings       — пороги защит и настройки (чтение регистров 0x10–0x3F)
//   POST /api/firmware/inspect — проверка файла .hex (тело запроса — текст файла)
//   POST /api/firmware/flash   — запись прошивки (сейчас отказывает, см. firmware.mjs)
//   GET  /update/check       — есть ли новый коммит на GitHub
//   POST /update/run         — установить обновление
//   GET  /update/status      — ход обновления
//
// Код выхода 10 означает «перезапустите меня» (его обрабатывает run.sh).

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { BmsClient } from './bms-client.mjs';
import { SETTINGS } from './jbd-protocol.mjs';
import { listSerialPorts, openSerialTransport } from './serial-transport.mjs';
import { createFakeTransport } from './fake-bms.mjs';
import { inspectFirmwareFile, flashFirmware, FirmwareError } from './firmware.mjs';
import { createUpdater, RESTART_EXIT_CODE } from './updater.mjs';
import { parseIntelHex } from './intel-hex.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(APP_DIR, 'dist');
const MAX_BODY = 1024 * 1024;

const pkg = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8'));
export const VERSION = { app: pkg.version, commit: gitShortSha() };

function gitShortSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return '';
  }
}

/** Состояние подключения к одной плате. */
const session = {
  transport: null,
  client: null,
  port: null,
  demo: false,
  deviceName: '',
  lastError: '',
  failures: 0,
  firmwareText: null,
  firmwareName: '',
};

const updater = createUpdater({ appDir: APP_DIR, log: (m) => console.log('автообновление: ' + m) });

// ---------- подключение ----------

async function disconnect() {
  const c = session.client;
  const t = session.transport;
  session.client = null;
  session.transport = null;
  session.port = null;
  session.demo = false;
  session.deviceName = '';
  session.failures = 0;
  try { if (c) await c.close(); else if (t) await t.close(); } catch { /* порт уже закрыт */ }
}

async function connect(path) {
  await disconnect();
  let transport;
  if (path === 'demo') {
    transport = createFakeTransport({ cellCount: 4, name: 'DEMO JBD 4S 12V' });
  } else {
    transport = await openSerialTransport(path);
  }
  const client = new BmsClient(transport, { timeoutMs: 800, retries: 2 });
  try {
    const basic = await client.readBasicInfo();
    let name = '';
    try { name = await client.readDeviceName(); } catch { /* не у всех прошивок есть имя */ }
    session.transport = transport;
    session.client = client;
    session.port = path;
    session.demo = path === 'demo';
    session.deviceName = name;
    session.lastError = '';
    session.failures = 0;
    return { basic, deviceName: name };
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
}

function requireClient() {
  if (!session.client) throw httpError(409, 'NOT_CONNECTED', 'Плата не подключена.');
  return session.client;
}

function httpError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// ---------- данные ----------

function cellStats(cells) {
  if (!cells.length) return null;
  let min = Infinity, max = -Infinity, sum = 0, minIndex = 0, maxIndex = 0;
  cells.forEach((v, i) => {
    sum += v;
    if (v < min) { min = v; minIndex = i; }
    if (v > max) { max = v; maxIndex = i; }
  });
  return { min, max, delta: max - min, avg: Math.round(sum / cells.length), minIndex, maxIndex };
}

async function snapshot() {
  const client = requireClient();
  const basic = await client.readBasicInfo();
  const cells = await client.readCellInfo();
  let errors = null;
  try { errors = await client.readErrorCounters(); } catch { /* не у всех прошивок */ }
  session.failures = 0;
  return {
    at: Date.now(),
    port: session.port,
    demo: session.demo,
    deviceName: session.deviceName,
    basic,
    cells: { values: cells, stats: cellStats(cells) },
    errors,
  };
}

async function readSettings() {
  const client = requireClient();
  const items = [];
  for (const def of SETTINGS) {
    try {
      const value = await client.readSetting(def);
      items.push({ key: def.key, label: def.label, unit: def.unit, value });
    } catch (e) {
      items.push({ key: def.key, label: def.label, unit: def.unit, value: null, error: e.message });
    }
  }
  return { at: Date.now(), items };
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const type = typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(payload);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'TOO_LARGE', 'Запрос слишком большой.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 64 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw httpError(400, 'BAD_JSON', 'Некорректный JSON.'); }
}

const PORT_RE = /^\/dev\/(tty[A-Za-z0-9]+|cu\.[A-Za-z0-9._-]+)$|^COM\d+$/;

async function handleApi(req, res, url) {
  const { pathname } = url;
  if (req.method === 'GET' && pathname === '/healthz') {
    return send(res, 200, { ok: true, ...VERSION });
  }
  if (req.method === 'GET' && pathname === '/api/ports') {
    return send(res, 200, { ports: await listSerialPorts(), demo: { path: 'demo', label: 'Демо-режим (без платы)' } });
  }
  if (req.method === 'POST' && pathname === '/api/connect') {
    const body = await readJson(req);
    const path = String(body.path || '');
    if (path !== 'demo' && !PORT_RE.test(path)) throw httpError(400, 'BAD_PORT', 'Недопустимое имя порта.');
    try {
      const { basic, deviceName } = await connect(path);
      return send(res, 200, { connected: true, port: path, demo: path === 'demo', deviceName, firmwareVersion: basic.firmwareVersion, cellCount: basic.cellCount });
    } catch (e) {
      session.lastError = e.message;
      throw httpError(502, 'CONNECT_FAILED', `Плата не отвечает: ${e.message}. Проверьте провода (TX/RX/GND), уровень 3.3 В и права доступа к порту.`);
    }
  }
  if (req.method === 'POST' && pathname === '/api/disconnect') {
    await disconnect();
    return send(res, 200, { connected: false });
  }
  if (req.method === 'GET' && pathname === '/api/state') {
    return send(res, 200, {
      connected: Boolean(session.client),
      port: session.port,
      demo: session.demo,
      deviceName: session.deviceName,
      lastError: session.lastError,
      firmwareLoaded: session.firmwareText !== null,
      firmwareName: session.firmwareName,
    });
  }
  if (req.method === 'GET' && pathname === '/api/snapshot') {
    try {
      return send(res, 200, await snapshot());
    } catch (e) {
      session.failures++;
      session.lastError = e.message;
      if (session.failures >= 3) await disconnect();
      throw httpError(502, 'READ_FAILED', `Нет ответа от BMS: ${e.message}`);
    }
  }
  if (req.method === 'GET' && pathname === '/api/settings') {
    return send(res, 200, await readSettings());
  }
  if (req.method === 'POST' && pathname === '/api/firmware/inspect') {
    const text = (await readBody(req, 1024 * 1024)).toString('utf8');
    const name = decodeURIComponent(String(req.headers['x-file-name'] || 'firmware.hex'));
    const info = inspectFirmwareFile(text, name);
    session.firmwareText = info.ok ? text : null;
    session.firmwareName = info.ok ? info.fileName : '';
    return send(res, 200, info);
  }
  if (req.method === 'POST' && pathname === '/api/firmware/flash') {
    const client = requireClient();
    if (session.firmwareText === null) throw httpError(409, 'NO_FILE', 'Сначала загрузите корректный файл прошивки.');
    const image = parseIntelHex(session.firmwareText);
    try {
      await flashFirmware(client, image);
      return send(res, 200, { ok: true });
    } catch (e) {
      if (e instanceof FirmwareError) throw httpError(409, e.code, e.message);
      throw e;
    }
  }
  if (req.method === 'GET' && pathname === '/update/check') {
    return send(res, 200, await updater.check());
  }
  if (req.method === 'POST' && pathname === '/update/run') {
    const snap = updater.run();
    return send(res, 202, snap);
  }
  if (req.method === 'GET' && pathname === '/update/status') {
    const snap = updater.snapshot();
    if (snap.restartRequired) scheduleRestart();
    return send(res, 200, snap);
  }
  throw httpError(404, 'NOT_FOUND', 'Нет такого адреса.');
}

let restartScheduled = false;
function scheduleRestart() {
  if (restartScheduled) return;
  restartScheduled = true;
  setTimeout(async () => {
    await disconnect();
    process.exit(RESTART_EXIT_CODE);
  }, 1500);
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = normalize(join(DIST, rel));
  if (!file.startsWith(DIST)) return send(res, 403, { error: 'FORBIDDEN', message: 'Доступ запрещён.' });
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    return send(res, 200, body, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  } catch {
    // адреса интерфейса без расширения — отдаём index.html
    if (!extname(rel)) {
      try {
        const html = await readFile(join(DIST, 'index.html'));
        return send(res, 200, html, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      } catch { /* ниже */ }
    }
    return send(res, 404, { error: 'NOT_FOUND', message: 'Файл не найден. Соберите программу: npm run build.' });
  }
}

export function createAppServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/update/') || url.pathname === '/healthz') {
        await handleApi(req, res, url);
      } else {
        await serveStatic(req, res, url.pathname);
      }
    } catch (e) {
      const status = e.status || 500;
      send(res, status, { error: e.code || 'ERROR', message: e.message || String(e) });
    }
  });
}

// ---------- запуск ----------

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/** Режим запуска из run.sh: проверить GitHub и при необходимости установить обновление, без сервера. */
async function updateNow() {
  const c = await updater.check();
  if (c.updateAvailable) {
    updater.run();
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      const s = updater.snapshot();
      if (s.phase !== 'running' && !s.running) break;
    }
  }
  const s = updater.snapshot();
  console.log(`автообновление: ${s.message}`);
  return s.phase === 'error' ? 1 : 0;
}

if (isMain && process.argv.includes('--update-now')) {
  process.exit(await updateNow());
}

if (isMain) {
  const host = process.env.BMS_APP_HOST || '127.0.0.1';
  const port = Number(process.argv[2] || process.env.BMS_APP_PORT || 8585);
  const server = createAppServer();
  server.listen(port, host, () => {
    console.log(`JBD BMS: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}  (версия ${VERSION.app}${VERSION.commit ? ', ' + VERSION.commit : ''})`);
  });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Порт ${port} занят. Укажите другой: node scripts/server.mjs 8590` : e.message);
    process.exit(1);
  });
  // проверка обновлений: сразу после старта и затем раз в 30 минут (не мешаем запуску)
  setTimeout(() => updater.check(), 4000).unref();
  setInterval(() => updater.check(), updater.CHECK_INTERVAL_MS).unref();

  const shutdown = async () => {
    await disconnect();
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

