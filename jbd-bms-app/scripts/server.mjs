#!/usr/bin/env node
// Локальный сервер JBD BMS: отдаёт панель и API к платам по UART.
//
//   node scripts/server.mjs [порт]
//   node scripts/server.mjs --update-now   — проверить GitHub и обновиться (для run.sh)
//
// По умолчанию слушает только 127.0.0.1 (порт 8585): плата подключена к этому
// компьютеру, наружу её открывать не нужно. Переменные окружения:
//   BMS_APP_HOST  — адрес (по умолчанию 127.0.0.1)
//   BMS_APP_PORT  — порт (по умолчанию 8585)
//   BMS_POLL_MS   — период опроса плат (по умолчанию 1000 мс)
//
// API (основное):
//   GET  /api/panel?focus=<id>&window=600 — вся панель одним запросом: строки банков,
//                                            итоги по парку, ряды для графиков
//   GET  /api/banks                       — список банков (строки отчёта)
//   POST /api/banks/add {path,label}      — подключить банк на порту
//   POST /api/banks/demo {count}          — подключить демо-банки без платы
//   POST /api/banks/auto                  — найти батареи на всех портах и подключить каждую
//   POST /api/banks/remove {id}           — отключить банк
//   POST /api/banks/rename {id,label}     — подпись банка в отчёте
//   POST /api/banks/reconnect {id}        — перезайти на порт
//   GET  /api/bank/registers?id=          — все регистры банка: паспорт + настройки + ошибки
//   GET  /api/bank/settings?id=           — только пороги защит и EEPROM-настройки
//   POST /api/bank/settings/write         — {id, changes, confirm, password, save, risk}
//   POST /api/bank/control {id,action,…}  — ключи, остаток, балансировка, сбросы (id=all — всем)
//   POST /api/bank/raw/read {id,regs}     — сырое чтение любых регистров (консоль)
//   POST /api/bank/raw/write {id,reg,…}   — сырая запись регистра (консоль, с подтверждением)
//   GET  /api/report[?id=]                — полный отчёт по всем банкам (JSON)
//   GET  /api/report.csv                  — тот же отчёт в CSV (для Excel/Sheets)
//   GET  /api/history?id=&seconds=        — история выборок банка для графиков
//   GET  /api/catalog                     — описания регистров, настроек и команд
//   POST /api/poll {ms}                    — задать период опроса
//   GET  /api/printer                     — статус TTL-чекового принтера
//   POST /api/printer/config              — настройки принтера (порт, скорость, ширина, вид чека, язык)
//   POST /api/printer/query               — спросить у принтера состояние (нет бумаги, ошибка)
//   POST /api/printer/detect              — автопоиск скорости UART по ответу принтера
//   POST /api/printer/sweep               — печать блоков на всех скоростях (ищем читаемый)
//   POST /api/printer/test                — пробная страница
//   POST /api/printer/print {id, level, language, charset}
//                                         — печать сводки по банку (id=all — по парку);
//                                           level: short (короткая) | medium (средняя) | full (полная);
//                                           language: en (английский, ASCII) | ru (русский, кириллица);
//                                           charset: cp866 | cp1251 | utf8 (для русского чека);
//                                           без level и language берутся настройки принтера
//   GET  /api/printer/preview?id=&level=&language=
//                                         — тот же чек текстом, без печати (id=all — парк, id=test — пробная)
//   Чеки на английском, ASCII; скорость и профиль должны соответствовать модели.
//
// Старые одиночные адреса сохранены: /api/connect, /api/disconnect, /api/state,
// /api/snapshot, /api/settings, /api/settings/write, /api/control/*, /api/backup*,
// /api/firmware/*, /api/ports, /api/scan, /update/*. Они работают с первым банком.
//
// Код выхода 10 означает «перезапустите меня» (его обрабатывает run.sh).

import { randomUUID } from 'node:crypto';
import { supervise } from './start.mjs';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { BankManager, cellStats } from './banks.mjs';
import {
  SETTINGS, WRITE_LIMITS, INFO_REGS, CONTROL_CMDS, REG_CATALOG, FAULT_BITS, REG, writableDefs,
  ERROR_COUNTER_NAMES,
} from './jbd-protocol.mjs';
import { listSerialPorts, openSerialTransport } from './serial-transport.mjs';
import { scanBmsPorts } from './port-scan.mjs';
import { inspectFirmwareFile, flashFirmware, FirmwareError } from './firmware.mjs';
import { createUpdater, RESTART_EXIT_CODE } from './updater.mjs';
import { parseIntelHex } from './intel-hex.mjs';
import { PrinterService, REPORT_LEVELS, PRINTER_LANGUAGES, PRINTER_CHARSETS } from './printer-service.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(APP_DIR, 'dist');
const MAX_BODY = 1024 * 1024;

const pkg = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8'));
const instanceId = randomUUID();
export const VERSION = { app: pkg.version, commit: gitShortSha() };

function gitShortSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return '';
  }
}

// ---------- банки (платы) ----------

export const banks = new BankManager({
  pollMs: Number(process.env.BMS_POLL_MS || 1000),
  openTransport: openSerialTransport,
  log: (m) => console.log('банк: ' + m),
});
banks.start();

// Порт принтера не должен опрашиваться как BMS: кадр опроса (dd a5 03 00 ff fd 77)
// принтер напечатает иероглифами. isPortBusy не даёт печатать в порт, занятый платой.
export const printer = new PrinterService({
  // HTTP-тесты не должны менять настройки установленной программы.
  configFile: process.env.BMS_PRINTER_CONFIG || (process.env.NODE_TEST_CONTEXT ? null : join(APP_DIR, 'printer.json')),
  log: (m) => console.log('принтер: ' + m),
  isPortBusy: (path) => Boolean(path) && banks.list().some((b) => b.path === path),
});

const firmware = { text: null, name: '' };

function httpError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

/** Первый банк — адресам старого формата нужен именно он. */
function primaryId() {
  const first = banks.list()[0];
  if (!first) throw httpError(409, 'NOT_CONNECTED', 'Плата не подключена.');
  return first.id;
}

/** Ответ в формате старого /api/snapshot (одна плата). */
function legacySnapshot(bank) {
  if (!bank.basic) throw httpError(502, 'READ_FAILED', 'Плата ещё не ответила на опрос.');
  return {
    at: bank.at,
    port: bank.path,
    demo: bank.demo,
    deviceName: bank.deviceName,
    basic: bank.basic,
    cells: { values: bank.cells?.values ?? [], stats: cellStats(bank.cells?.values ?? []) },
    errors: bank.errors,
  };
}

/**
 * Опрос портов: все, кроме занятых подключёнными банками и кроме порта принтера.
 * Порт принтера исключён всегда (даже с force): поиск плат шлёт в него кадры
 * dd a5 03 00 ff fd 77, и принтер печатает их непонятными символами.
 */
async function scanApi({ includeConnected = false } = {}) {
  const used = new Set(banks.list().map((b) => b.path));
  const skip = new Set([printer.config.path].filter(Boolean));
  const ports = (await listSerialPorts())
    .filter((p) => !skip.has(p.path) && (includeConnected || !used.has(p.path)));
  const results = await scanBmsPorts(ports);
  return { at: Date.now(), results, found: results.filter((r) => r.found).map((r) => r.path), busy: [...used], skipped: [...skip] };
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
  const buf = await readBody(req, 256 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw httpError(400, 'BAD_JSON', 'Некорректный JSON.'); }
}

const PORT_RE = /^\/dev\/(tty[A-Za-z0-9._-]+|cu\.[A-Za-z0-9._-]+)$|^COM\d+$/i;

function checkPath(path) {
  if (path !== 'demo' && !PORT_RE.test(path)) throw httpError(400, 'BAD_PORT', 'Недопустимое имя порта.');
  return path;
}

/**
 * Порт, отданный принтеру, нельзя занимать под плату: опрос BMS шлёт в него
 * кадры dd a5 03 00 ff fd 77, и принтер печатает их непонятными символами
 * вместо чека (плюс порт остаётся заблокированным для печати).
 */
function checkNotPrinterPort(path) {
  if (path === printer.config.path) {
    throw httpError(409, 'PORT_IS_PRINTER',
      `Порт ${path} — чековый принтер. Опрос BMS на нём печатает непонятные символы вместо чека, `
      + 'поэтому плату на него не подключаем. Выберите порт платы.');
  }
  return path;
}

function secondsOf(url) {
  const raw = Number(url.searchParams.get('seconds') || url.searchParams.get('window') || 600);
  return Math.max(15, Math.min(7200, Number.isFinite(raw) && raw > 0 ? raw : 600));
}

/**
 * Язык чека из запроса: английский (en) или русский (ru).
 * Без параметра возвращает null — тогда берётся язык из настроек принтера.
 */
function printerLanguage(raw) {
  const language = String(raw ?? '').trim().toLowerCase();
  if (!language) return null;
  if (!PRINTER_LANGUAGES.includes(language)) {
    throw httpError(400, 'BAD_LANGUAGE', `Неизвестный язык чека «${raw}»: английский (en) или русский (ru).`);
  }
  return language;
}

/** Кодировка кириллицы из запроса: cp866, cp1251 или utf8. */
function printerCharset(raw) {
  const charset = String(raw ?? '').trim().toLowerCase();
  if (!charset) return null;
  if (!PRINTER_CHARSETS.includes(charset)) {
    throw httpError(400, 'BAD_CHARSET', `Неизвестная кодировка чека «${raw}»: cp866, cp1251 или utf8.`);
  }
  return charset;
}

/**
 * Вид чека из запроса: короткий (short), средний (medium) или полный (full).
 * Без параметра возвращает null — тогда печатается вид из настроек принтера.
 */
function printerLevel(raw) {
  const level = String(raw ?? '').trim().toLowerCase();
  if (!level) return null;
  if (!REPORT_LEVELS.includes(level)) {
    throw httpError(400, 'BAD_LEVEL',
      `Неизвестный вид чека «${raw}»: короткий (short), средний (medium) или полный (full).`);
  }
  return level;
}

/**
 * Предпросмотр чека для браузера: строки, байты для UART (массив чисел) и размер.
 * Байты нужны, чтобы видеть, что именно уйдёт в принтер в русском режиме.
 */
function previewJson(preview) {
  const { bytes, raw, ...rest } = preview;
  return {
    ...rest,
    bytes: [...bytes],
    byteLength: bytes.length,
    // весь чек можно отправить как есть, без команд: true — чистый ASCII
    ascii: bytes.every((b) => b === 0x0d || b === 0x0a || (b >= 0x20 && b < 0x7f)),
  };
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const q = url.searchParams;
  const method = req.method;

  if (method === 'GET' && pathname === '/healthz') return send(res, 200, { ok: true, ...VERSION, instanceId });

  // ----- каталог и списки -----
  if (method === 'GET' && pathname === '/api/catalog') {
    return send(res, 200, {
      settings: SETTINGS.map((d) => {
        const lim = WRITE_LIMITS[d.key];
        return {
          key: d.key, label: d.label, unit: d.unit, reg: d.reg, hex: `0x${d.reg.toString(16).padStart(2, '0')}`,
          kind: d.kind, byte: d.byte ?? null, group: lim?.group ?? d.group ?? 'Прочее',
          editable: Boolean(lim), risky: Boolean(lim?.risky), min: lim?.min ?? null, max: lim?.max ?? null, step: lim?.step ?? null,
          bits: d.bits ?? null,
        };
      }),
      info: INFO_REGS.map((d) => ({ ...d, hex: `0x${d.reg.toString(16).padStart(2, '0')}` })),
      control: CONTROL_CMDS,
      regs: REG_CATALOG,
      faults: FAULT_BITS,
      errorCounters: ERROR_COUNTER_NAMES.map(([key, label]) => ({ key, label })),
      writable: writableDefs().map((d) => d.key),
    });
  }
  if (method === 'GET' && pathname === '/api/ports') {
    const used = new Set(banks.list().map((b) => b.path));
    const printerPath = printer.config.path;
    return send(res, 200, {
      printerPath,
      ports: (await listSerialPorts()).map((p) => ({
        ...p,
        used: used.has(p.path),
        printer: Boolean(printerPath) && p.path === printerPath,
      })),
      demo: { path: 'demo', label: 'Демо-режим (без платы)' },
    });
  }

  // ----- панель -----
  if (method === 'GET' && pathname === '/api/panel') {
    return send(res, 200, banks.panel({ focus: q.get('focus'), seconds: secondsOf(url) }));
  }
  if (method === 'GET' && pathname === '/api/banks') return send(res, 200, { at: Date.now(), pollMs: banks.pollMs, banks: banks.list().map((b) => banks.row(b)) });
  if (method === 'POST' && pathname === '/api/banks/add') {
    const body = await readJson(req);
    const path = checkNotPrinterPort(checkPath(String(body.path || '')));
    try {
      const bank = await banks.add({ path, label: String(body.label || '') });
      return send(res, 200, { id: bank.id, path: bank.path, label: bank.label, deviceName: bank.deviceName, cellCount: bank.basic?.cellCount ?? 0 });
    } catch (e) {
      if (e.status) throw e;
      throw httpError(502, 'CONNECT_FAILED', connectHint(path, e.message));
    }
  }
  if (method === 'POST' && pathname === '/api/banks/demo') {
    const body = await readJson(req);
    const count = Math.max(1, Math.min(6, Number(body.count) || 4));
    const added = [];
    for (let i = 0; i < count; i++) {
      const bank = await banks.add({ path: 'demo', label: `ДЕМО ${String.fromCharCode(65 + i)}`, demo: true });
      added.push({ id: bank.id, label: bank.label, cellCount: bank.basic?.cellCount ?? 0 });
    }
    return send(res, 200, { added });
  }
  if (method === 'POST' && pathname === '/api/banks/auto') {
    const scan = await scanApi({ includeConnected: q.get('force') === '1' });
    const r = await banks.autoConnect({ ports: scan.results, results: scan.results });
    return send(res, 200, { ...r, scanned: scan.results.length });
  }
  if (method === 'POST' && pathname === '/api/banks/remove') {
    const body = await readJson(req);
    const id = String(body.id || '');
    if (!id) throw httpError(400, 'NO_ID', 'Не указан банк.');
    return send(res, 200, await banks.remove(id));
  }
  if (method === 'POST' && pathname === '/api/banks/rename') {
    const body = await readJson(req);
    return send(res, 200, banks.rename(String(body.id || ''), String(body.label || '')));
  }
  if (method === 'POST' && pathname === '/api/banks/reconnect') {
    const body = await readJson(req);
    return send(res, 200, await banks.reconnect(String(body.id || '')));
  }
  if (method === 'POST' && pathname === '/api/poll') {
    const body = await readJson(req);
    return send(res, 200, { pollMs: banks.setPollMs(body.ms) });
  }
  if (method === 'GET' && pathname === '/api/history') {
    const id = q.get('id');
    const bank = id ? banks.get(id) : banks.list()[0];
    if (!bank) throw httpError(409, 'NOT_CONNECTED', 'Банки не подключены.');
    return send(res, 200, { id: bank.id, series: banks.series(bank, { seconds: secondsOf(url) }) });
  }

  // ----- данные одного банка -----
  if (method === 'GET' && pathname === '/api/bank/registers') {
    const id = q.get('id') || primaryId();
    const bank = banks.get(id);
    const settings = await banks.readSettings(bank.id);
    return send(res, 200, {
      at: Date.now(), id: bank.id, label: bank.label, port: bank.path,
      info: bank.info, infoAt: bank.infoAt, deviceName: bank.deviceName,
      basic: bank.basic, cells: bank.cells, errors: bank.errors, settings: settings.items,
    });
  }
  if (method === 'GET' && pathname === '/api/bank/info') {
    const id = q.get('id') || primaryId();
    const bank = banks.get(id);
    return send(res, 200, { at: Date.now(), info: await banks.readInfo(bank) });
  }
  if (method === 'GET' && pathname === '/api/bank/settings') {
    return send(res, 200, await banks.readSettings(q.get('id') || primaryId()));
  }
  if (method === 'POST' && pathname === '/api/bank/settings/write') {
    const body = await readJson(req);
    return send(res, 200, await banks.writeSettings(body.id || primaryId(), body));
  }
  if (method === 'POST' && pathname === '/api/bank/control') {
    const body = await readJson(req);
    const action = String(body.action || '');
    return send(res, 200, await banks.control(body.id || primaryId(), action, body));
  }
  if (method === 'POST' && pathname === '/api/bank/raw/read') {
    const body = await readJson(req);
    const regs = Array.isArray(body.regs) ? body.regs : [];
    if (!regs.length) throw httpError(400, 'NO_REGS', 'Не указаны регистры.');
    return send(res, 200, await banks.rawRead(body.id || primaryId(), regs));
  }
  if (method === 'POST' && pathname === '/api/bank/raw/write') {
    const body = await readJson(req);
    return send(res, 200, await banks.rawWrite(body.id || primaryId(), body));
  }
  if (method === 'GET' && pathname === '/api/backup') {
    return send(res, 200, await banks.backup(q.get('id') || primaryId()));
  }
  if (method === 'POST' && pathname === '/api/backup/restore') {
    const body = await readJson(req);
    const file = body.file;
    if (!file || typeof file.items !== 'object' || file.items === null) {
      throw httpError(400, 'BAD_BACKUP', 'Файл не похож на копию настроек JBD BMS.');
    }
    return send(res, 200, await banks.restore(body.id || primaryId(), { ...body, items: file.items }));
  }

  // ----- отчёт по всему парку -----
  if (method === 'GET' && pathname === '/api/report') {
    return send(res, 200, await banks.report({ id: q.get('id') || null, settings: q.get('settings') !== '0' }));
  }
  if (method === 'GET' && pathname === '/api/report.csv') {
    await Promise.all(banks.list().map((b) => banks.readSettings(b.id).catch(() => null)));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return send(res, 200, '\ufeff' + banks.csv(), {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="bms-report-${stamp}.csv"`,
    });
  }

  // ----- старые одиночные адреса -----
  if (method === 'POST' && pathname === '/api/connect') {
    const body = await readJson(req);
    const path = checkNotPrinterPort(checkPath(String(body.path || '')));
    await banks.removeAll();
    try {
      const bank = await banks.add({ path });
      return send(res, 200, {
        connected: true, port: path, demo: path === 'demo', deviceName: bank.deviceName,
        firmwareVersion: bank.basic?.firmwareVersion ?? 0, cellCount: bank.basic?.cellCount ?? 0, id: bank.id,
      });
    } catch (e) {
      if (e.status && e.code === 'CONNECT_FAILED') throw e;
      throw httpError(502, 'CONNECT_FAILED', connectHint(path, e.message));
    }
  }
  if (method === 'POST' && pathname === '/api/disconnect') {
    await banks.removeAll();
    return send(res, 200, { connected: false });
  }
  if (method === 'POST' && pathname === '/api/scan') {
    return send(res, 200, await scanApi());
  }
  if (method === 'GET' && pathname === '/api/state') {
    const bank = banks.list()[0] ?? null;
    return send(res, 200, {
      connected: Boolean(bank?.connected), port: bank?.path ?? null, demo: Boolean(bank?.demo),
      deviceName: bank?.deviceName ?? '', lastError: bank?.lastError ?? '',
      banks: banks.list().length,
      firmwareLoaded: firmware.text !== null, firmwareName: firmware.name,
    });
  }
  if (method === 'GET' && pathname === '/api/snapshot') {
    const bank = banks.get(q.get('id') || primaryId());
    if (!bank.connected) throw httpError(502, 'READ_FAILED', `Нет ответа от BMS: ${bank.lastError || 'банк не подключён'}`);
    return send(res, 200, legacySnapshot(bank));
  }
  if (method === 'GET' && pathname === '/api/settings') {
    return send(res, 200, await banks.readSettings(primaryId()));
  }
  if (method === 'POST' && pathname === '/api/settings/write') {
    const body = await readJson(req);
    return send(res, 200, await banks.writeSettings(primaryId(), body));
  }
  if (method === 'POST' && pathname === '/api/control/fet') {
    const body = await readJson(req);
    return send(res, 200, await banks.control(primaryId(), 'fet', { ...body, charge: body.charge, discharge: body.discharge }));
  }
  if (method === 'POST' && pathname === '/api/control/capacity') {
    const body = await readJson(req);
    return send(res, 200, await banks.control(primaryId(), 'capacity', body));
  }
  if (method === 'POST' && pathname === '/api/control/clear-errors') {
    const body = await readJson(req);
    return send(res, 200, await banks.control(primaryId(), 'clear-errors', body));
  }

  // ----- чековый принтер (UART TTL) -----
  if (method === 'GET' && pathname === '/api/printer') {
    return send(res, 200, printer.status());
  }
  if (method === 'POST' && pathname === '/api/printer/config') {
    const body = await readJson(req);
    if (printer.printing) throw httpError(409, 'PRINTER_BUSY', 'Дождитесь окончания печати.');
    // Порт отдали принтеру — если на нём висел банк, отключаем его: иначе опрос
    // платы (dd a5 03 …) продолжит печататься на принтере поверх чека.
    let freedPort = '';
    const next = typeof body.path === 'string' ? body.path.trim() : '';
    // порт освобождаем и при смене порта, и при повторном выборе того же (кнопка «освободить порт»)
    if (next && (next !== printer.config.path || printer.isPortBusy(next))) {
      const clash = banks.list().find((b) => b.path === next);
      if (clash) {
        await banks.remove(clash.id).catch(() => {});
        freedPort = next;
        console.log(`принтер: порт ${next} освобождён от банка «${clash.label}» — теперь это порт принтера`);
      }
    }
    return send(res, 200, { ...printer.configure(body), freedPort });
  }
  if (method === 'POST' && pathname === '/api/printer/query') {
    return send(res, 200, await printer.queryPrinter());
  }
  if (method === 'POST' && pathname === '/api/printer/detect') {
    return send(res, 200, await printer.detectBaud());
  }
  if (method === 'POST' && pathname === '/api/printer/sweep') {
    return send(res, 200, await printer.sweepBauds());
  }
  if (method === 'POST' && pathname === '/api/printer/diagnostic') {
    return send(res, 200, await printer.diagnostic());
  }
  if (method === 'POST' && pathname === '/api/printer/test') {
    return send(res, 200, await printer.testPage());
  }
  if (method === 'POST' && pathname === '/api/printer/print') {
    const body = await readJson(req);
    const target = body.id === 'all' || body.all ? null : (body.id || null);
    // вид чека и язык: без них печатается то, что выбрано в настройках принтера
    const level = printerLevel(body.level ?? body.reportLevel);
    const opts = {
      language: printerLanguage(body.language ?? body.lang),
      charset: printerCharset(body.charset),
    };
    if (target === null) {
      const rows = banks.list().map((b) => banks.row(b));
      if (!rows.length) throw httpError(409, 'NO_BANK', 'Нет подключённых аккумуляторов.');
      return send(res, 200, await printer.printFleet(rows, banks.fleet(), level, opts));
    }
    const bank = banks.get(target);
    // обновляем данные, если банк на связи; не падаем, если опрос не удался — печатаем то, что есть
    if (bank.connected) await banks.pollOne(bank).catch(() => {});
    return send(res, 200, await printer.printBank(banks.row(bank), banks.fleet(), level, opts));
  }
  if (method === 'GET' && pathname === '/api/printer/preview') {
    const id = q.get('id') || 'all';
    if (id === 'test') return send(res, 200, previewJson(printer.previewTest()));
    const level = printerLevel(q.get('level') ?? q.get('reportLevel'));
    const language = printerLanguage(q.get('language') ?? q.get('lang'));
    if (id === 'all') {
      const rows = banks.list().map((b) => banks.row(b));
      if (!rows.length) throw httpError(409, 'NO_BANK', 'Нет подключённых аккумуляторов.');
      return send(res, 200, previewJson(printer.previewFleet(rows, banks.fleet(), level, language)));
    }
    return send(res, 200, previewJson(printer.previewBank(banks.row(banks.get(id)), banks.fleet(), level, language)));
  }

  // ----- прошивка -----
  if (method === 'POST' && pathname === '/api/firmware/inspect') {
    const text = (await readBody(req, 1024 * 1024)).toString('utf8');
    const name = decodeURIComponent(String(req.headers['x-file-name'] || 'firmware.hex'));
    const info = inspectFirmwareFile(text, name);
    firmware.text = info.ok ? text : null;
    firmware.name = info.ok ? info.fileName : '';
    return send(res, 200, info);
  }
  if (method === 'POST' && pathname === '/api/firmware/flash') {
    const bank = banks.get(primaryId());
    if (firmware.text === null) throw httpError(409, 'NO_FILE', 'Сначала загрузите корректный файл прошивки.');
    const image = parseIntelHex(firmware.text);
    try {
      await flashFirmware(bank.client, image);
      return send(res, 200, { ok: true });
    } catch (e) {
      if (e instanceof FirmwareError) throw httpError(409, e.code, e.message);
      throw e;
    }
  }

  // ----- обновления -----
  if (method === 'GET' && pathname === '/update/check') return send(res, 200, { ...await updater.check(), instanceId });
  if (method === 'POST' && pathname === '/update/run') return send(res, 202, { ...updater.run(), instanceId });
  if (method === 'GET' && pathname === '/update/status') {
    const snap = updater.snapshot();
    if (snap.restartRequired) scheduleRestart();
    return send(res, 200, { ...snap, instanceId });
  }
  throw httpError(404, 'NOT_FOUND', 'Нет такого адреса.');
}

/** Подсказка к ошибке подключения: что делать, если порт не открылся или молчит. */
function connectHint(path, message) {
  if (/не удалось открыть|Permission denied|EACCES|resource busy|Device or resource busy/i.test(message)) {
    return `Порт ${path} не открылся (${message}). Закройте другие программы, которые могут его занимать (например, JBDTools), и проверьте права доступа: в Ubuntu — группа dialout.`;
  }
  if (/не отвечает/i.test(message)) return message;
  return `Плата не отвечает: ${message}. Проверьте провода (TX/RX/GND), уровень 3.3 В и выбран ли нужный порт. Если не знаете порт — «Найти и подключить все».`;
}

const updater = createUpdater({ appDir: APP_DIR, log: (m) => console.log('автообновление: ' + m), onReady: scheduleRestart });

let restartScheduled = false;
function scheduleRestart() {
  if (restartScheduled) return;
  restartScheduled = true;
  setTimeout(async () => {
    // Закрываем UART до запуска нового процесса; зависший драйвер не блокирует перезапуск.
    const watchdog = setTimeout(() => process.exit(RESTART_EXIT_CODE), 5000);
    try { await banks.removeAll(); await printer.close(); }
    finally { clearTimeout(watchdog); process.exit(RESTART_EXIT_CODE); }
  }, 1500);
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  // тексты инструкций лежат вне сборки (docs/) — отдаём их как есть, только .md из этой папки
  if (rel.startsWith('/docs/')) {
    const file = normalize(join(APP_DIR, 'docs', basename(rel)));
    if (file.startsWith(join(APP_DIR, 'docs')) && file.endsWith('.md')) {
      try {
        const body = await readFile(file);
        return send(res, 200, body, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
      } catch { /* ниже — обычная обработка статики */ }
    }
  }
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

if (isMain && process.env.BMS_APP_SUPERVISED !== '1') {
  process.exit(await supervise(process.argv.slice(2)));
}

if (isMain) {
  const host = process.env.BMS_APP_HOST || '127.0.0.1';
  const port = Number(process.argv[2] || process.env.BMS_APP_PORT || 8585);
  const demoFirst = process.env.BMS_DEMO_BANKS ? Number(process.env.BMS_DEMO_BANKS) : 0;
  const server = createAppServer();
  if (demoFirst > 0) {
    for (let i = 0; i < Math.min(6, demoFirst); i++) {
      await banks.add({ path: 'demo', label: `ДЕМО ${String.fromCharCode(65 + i)}`, demo: true }).catch(() => {});
    }
  }
  // BMS_AUTOCONNECT=1 — при старте опросить все порты и подключить каждую найденную плату
  if (process.env.BMS_AUTOCONNECT === '1' && !demoFirst) {
    setTimeout(() => {
      scanApi().then((scan) => banks.autoConnect({ ports: scan.results, results: scan.results }))
        .then((r) => r.added.length && console.log(`автоподключение: банков ${r.added.length}`))
        .catch(() => { /* плат нет — просто стартуем с пустой панелью */ });
    }, 300).unref();
  }
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
    banks.stop();
    await banks.removeAll();
    await printer.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
