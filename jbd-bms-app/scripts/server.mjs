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
//   POST /api/scan           — найти батарею: опросить все порты и вернуть, где ответила плата
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
import {
  SETTINGS, WRITE_LIMITS, writableDefs, checkSettingValue, checkSettingsConsistency,
  settingToRaw, passwordBytes, decodeSetting,
  CTRL_REG, fetRaw, capRemRaw,
} from './jbd-protocol.mjs';
import { listSerialPorts, openSerialTransport } from './serial-transport.mjs';
import { scanBmsPorts } from './port-scan.mjs';
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
    transport = createFakeTransport({ cellCount: 12, name: 'DEMO JBD 12S' });
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

/** Опрос всех портов: где отвечает BMS. Пока плата подключена, порты не трогаем. */
async function scanApi() {
  if (session.client) throw httpError(409, 'CONNECTED', 'Плата уже подключена. Сначала нажмите «Отключить», затем ищите батарею.');
  const ports = await listSerialPorts();
  const results = await scanBmsPorts(ports);
  return { at: Date.now(), results, found: results.filter((r) => r.found).map((r) => r.path) };
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
    const lim = WRITE_LIMITS[def.key];
    const base = { key: def.key, label: def.label, unit: def.unit, editable: Boolean(lim) };
    if (lim) Object.assign(base, { group: lim.group, min: lim.min, max: lim.max, step: lim.step });
    try {
      const value = await client.readSetting(def);
      items.push({ ...base, value });
    } catch (e) {
      items.push({ ...base, value: null, error: e.message });
    }
  }
  return { at: Date.now(), items };
}

/**
 * Запись настроек. Принимает только явное подтверждение (confirm: true), проверяет пределы
 * и связи порогов с текущими значениями платы, пишет одной операцией и сверяет каждое
 * значение чтением после записи.
 */
async function writeSettingsApi(body) {
  const client = requireClient();
  if (body.confirm !== true) throw httpError(400, 'NOT_CONFIRMED', 'Запись не подтверждена.');
  const changes = body.changes && typeof body.changes === 'object' ? body.changes : null;
  if (!changes) throw httpError(400, 'BAD_CHANGES', 'Не переданы изменения.');
  const keys = Object.keys(changes);
  if (keys.length === 0) throw httpError(400, 'NO_CHANGES', 'Нет изменений для записи.');
  if (keys.length > 40) throw httpError(400, 'TOO_MANY', 'Слишком много изменений за один раз.');

  const writable = new Set(writableDefs().map((d) => d.key));
  const errors = [];
  for (const key of keys) {
    if (!writable.has(key)) { errors.push(`параметр «${key}» нельзя записать из приложения`); continue; }
    const value = Number(changes[key]);
    const err = checkSettingValue(key, value);
    if (err) errors.push(err);
  }
  if (errors.length) throw httpError(400, 'INVALID_VALUES', errors.join('; '));

  let password;
  try {
    password = typeof body.password === 'string' ? body.password : '';
    passwordBytes(password);
  } catch (e) {
    throw httpError(400, 'BAD_PASSWORD', e.message);
  }
  const save = body.save !== false;

  // текущие значения платы: нужны для сравнения и для проверки связей порогов
  const current = {};
  for (const def of SETTINGS) {
    try { current[def.key] = await client.readSetting(def); } catch { /* значение не прочитано — связь не проверяем */ }
  }
  const merged = { ...current };
  for (const key of keys) merged[key] = Number(changes[key]);
  const consistency = checkSettingsConsistency(merged);
  if (consistency.length) throw httpError(400, 'INCONSISTENT', consistency.join('; '));

  const defs = keys.map((key) => SETTINGS.find((d) => d.key === key));
  const toWrite = defs
    .filter((d) => current[d.key] === undefined || Number(current[d.key]) !== Number(changes[d.key]))
    .map((d) => ({ def: d, value: Number(changes[d.key]), raw: settingToRaw(d, Number(changes[d.key])) }));
  if (toWrite.length === 0) {
    return { ok: true, saved: false, changed: 0, items: [], message: 'Значения уже совпадают с платой — ничего не записано.' };
  }

  try {
    await client.writeSettings(toWrite.map((w) => ({ reg: w.def.reg, raw: w.raw })), { save, password });
  } catch (e) {
    throw httpError(502, 'WRITE_FAILED', `Запись не выполнена: ${e.message}. Изменения не сохранены в память платы.`);
  }

  const items = [];
  for (const w of toWrite) {
    let actual = null;
    let ok = false;
    try {
      const raw = await client.readRaw(w.def);
      actual = decodeRawForDef(w.def, raw);
      ok = raw === w.raw;
    } catch (e) {
      actual = null;
    }
    items.push({
      key: w.def.key, label: w.def.label, unit: w.def.unit,
      before: current[w.def.key] ?? null, requested: w.value, actual, ok,
    });
  }
  const allOk = items.every((i) => i.ok);
  return {
    ok: allOk,
    saved: save && allOk,
    changed: toWrite.length,
    items,
    message: allOk
      ? (save
        ? `Записано ${toWrite.length} ${plural(toWrite.length)} и сохранено в память платы.`
        : `Записано ${toWrite.length} ${plural(toWrite.length)} (до выключения платы).`)
      : 'Часть значений не совпала при проверке. Перечитайте настройки и повторите запись.',
  };
}

function plural(n) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'параметр';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'параметра';
  return 'параметров';
}

function decodeRawForDef(def, raw) {
  return decodeSetting(def, Buffer.from([raw >> 8, raw & 0xff]));
}


// ---------- управление ----------

function requireConfirm(body) {
  if (body.confirm !== true) throw httpError(400, 'NOT_CONFIRMED', 'Действие не подтверждено.');
}

/** Ключи заряда и разряда. Регистр 0xE1, без сохранения в память платы. */
async function setFetApi(body) {
  const client = requireClient();
  requireConfirm(body);
  if (typeof body.charge !== 'boolean' || typeof body.discharge !== 'boolean') {
    throw httpError(400, 'BAD_FLAGS', 'Укажите charge и discharge (true/false).');
  }
  const raw = fetRaw({ charge: body.charge, discharge: body.discharge });
  try {
    await client.writeSettings([{ reg: CTRL_REG.CHG_DSG_EN, raw }], { save: false });
  } catch (e) {
    throw httpError(502, 'WRITE_FAILED', `Не удалось переключить ключи: ${e.message}`);
  }
  const basic = await client.readBasicInfo();
  const ok = basic.chargeFetOn === body.charge && basic.dischargeFetOn === body.discharge;
  return {
    ok,
    chargeFetOn: basic.chargeFetOn,
    dischargeFetOn: basic.dischargeFetOn,
    message: ok ? 'Ключи переключены.' : 'Плата показывает другое состояние ключей. Проверьте её вручную.',
  };
}

/** Остаток ёмкости (SOC). Регистр 0xE0, без сохранения. */
async function setCapacityApi(body) {
  const client = requireClient();
  requireConfirm(body);
  const ah = Number(body.ah);
  let raw;
  try { raw = capRemRaw(ah); } catch (e) { throw httpError(400, 'BAD_VALUE', e.message); }
  const basic = await client.readBasicInfo();
  if (ah < 0 || ah > basic.fullAh) {
    throw httpError(400, 'OUT_OF_RANGE', `Остаток должен быть от 0 до ${basic.fullAh} Ач (полная ёмкость).`);
  }
  try {
    await client.writeSettings([{ reg: CTRL_REG.CAP_REM, raw }], { save: false });
  } catch (e) {
    throw httpError(502, 'WRITE_FAILED', `Не удалось установить остаток: ${e.message}`);
  }
  const after = await client.readBasicInfo();
  return { ok: Math.abs(after.remainingAh - ah) < 0.05, remainingAh: after.remainingAh, fullAh: after.fullAh };
}

/** Сброс счётчиков ошибок: вход и выход из заводского режима с сохранением (как в bms-tools). */
async function clearErrorsApi(body) {
  const client = requireClient();
  requireConfirm(body);
  try {
    await client.writeSettings([], { save: true });
  } catch (e) {
    throw httpError(502, 'WRITE_FAILED', `Не удалось сбросить счётчики: ${e.message}`);
  }
  const errors = await client.readErrorCounters();
  const nonZero = Object.values(errors).some((v) => v !== 0);
  return { ok: !nonZero, errors, message: nonZero ? 'Часть счётчиков не обнулилась.' : 'Счётчики ошибок сброшены.' };
}

/** Текущие значения всех настроек (для резервной копии и сравнения). */
async function currentSettingsMap(client) {
  const out = {};
  for (const def of SETTINGS) {
    try { out[def.key] = await client.readSetting(def); } catch { /* пропускаем нечитаемые */ }
  }
  return out;
}

async function backupApi() {
  const client = requireClient();
  const values = await currentSettingsMap(client);
  return {
    format: 'jbd-settings',
    version: 1,
    createdAt: new Date().toISOString(),
    device: session.deviceName || '',
    items: values,
  };
}

/** Восстановление: dryRun — только перечень изменений; иначе — запись через обычный путь записи. */
async function restoreApi(body) {
  const client = requireClient();
  const file = body.file;
  if (!file || file.format !== 'jbd-settings' || typeof file.items !== 'object' || file.items === null) {
    throw httpError(400, 'BAD_BACKUP', 'Файл не похож на копию настроек JBD BMS.');
  }
  const current = await currentSettingsMap(client);
  const writable = new Set(writableDefs().map((d) => d.key));
  const changes = {};
  const skipped = [];
  const errors = [];
  const rows = [];
  for (const [key, value] of Object.entries(file.items)) {
    if (!writable.has(key)) { skipped.push(key); continue; }
    if (typeof value !== 'number') { errors.push(`«${key}»: не число`); continue; }
    const err = checkSettingValue(key, value);
    if (err) { errors.push(err); continue; }
    if (current[key] === undefined || Number(current[key]) !== value) {
      changes[key] = value;
      const def = SETTINGS.find((d) => d.key === key);
      rows.push({ key, label: def.label, unit: def.unit, from: current[key] ?? null, to: value });
    }
  }
  if (errors.length) throw httpError(400, 'INVALID_VALUES', errors.join('; '));
  if (body.dryRun !== false) {
    return { dryRun: true, changes: rows, skipped, same: Object.keys(file.items).length - rows.length - skipped.length };
  }
  if (rows.length === 0) return { ok: true, saved: false, changed: 0, items: [], message: 'Копия совпадает с платой — ничего не записано.' };
  return writeSettingsApi({ confirm: body.confirm, changes, save: body.save, password: body.password });
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

const PORT_RE = /^\/dev\/(tty[A-Za-z0-9]+|cu\.[A-Za-z0-9._-]+)$|^COM\d+$/i;

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
      const busy = /^не удалось открыть/.test(e.message);
      const text = busy
        ? `Порт ${path} не открылся (${e.message}). Закройте другие программы, которые могут его занимать (например, JBDTools), и проверьте права доступа: в Ubuntu — группа dialout.`
        : `Плата не отвечает: ${e.message}. Проверьте провода (TX/RX/GND), уровень 3.3 В и выбран ли нужный порт. Если не знаете порт, нажмите «Найти батарею».`;
      session.lastError = text;
      throw httpError(502, 'CONNECT_FAILED', text);
    }
  }
  if (req.method === 'POST' && pathname === '/api/scan') {
    return send(res, 200, await scanApi());
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
  if (req.method === 'POST' && pathname === '/api/control/fet') return send(res, 200, await setFetApi(await readJson(req)));
  if (req.method === 'POST' && pathname === '/api/control/capacity') return send(res, 200, await setCapacityApi(await readJson(req)));
  if (req.method === 'POST' && pathname === '/api/control/clear-errors') return send(res, 200, await clearErrorsApi(await readJson(req)));
  if (req.method === 'GET' && pathname === '/api/backup') return send(res, 200, await backupApi());
  if (req.method === 'POST' && pathname === '/api/backup/restore') return send(res, 200, await restoreApi(await readJson(req)));
  if (req.method === 'POST' && pathname === '/api/settings/write') {
    return send(res, 200, await writeSettingsApi(await readJson(req)));
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

