// Менеджер банков: столько плат BMS, сколько USB–UART адаптеров воткнуто.
//
// Каждый банк = порт + клиент протокола + свои данные (базовая информация,
// ячейки, счётчики ошибок, настройки) и своя история измерений для графиков.
// Опрос банков идёт параллельно (у каждого банка своя очередь запросов на
// порту), поэтому один «тупящий» адаптер не тормозит остальные.
//
// Модуль не знает про HTTP: сервер передаёт в него способ открыть порт.

import { BmsClient } from './bms-client.mjs';
import { openSerialTransport } from './serial-transport.mjs';
import {
  SETTINGS, WRITE_LIMITS, REG, INFO_REGS, CTRL_REG, fetRaw, capRemRaw,
  checkSettingValue, checkSettingsConsistency, encodeSetting, decodeSetting, decodeInfo,
  passwordBytes, decodeTemp, REG_CATALOG,
} from './jbd-protocol.mjs';
import { createFakeTransport, DEMO_BANKS } from './fake-bms.mjs';

const MAX_FAILURES = 3;
const CONTROL_ACTIONS = new Set(['fet', 'balance', 'capacity', 'clear-errors', 'soc-reset', 'soft-reset']);
/** Команды, которые нельзя выполнить «случайно»: нужен явный флаг risk. */
const RISKY_ACTIONS = new Set(['soc-reset', 'soft-reset']);
const SERIES_LIMIT_DEFAULT = 240;   // сколько точек отдаём на график
const SPARK_LIMIT = 40;             // мини-график в строке отчёта
const HISTORY_MAX = 7200;           // запас истории в выборках (2 ч при 1 с)

let bankSeq = 0;
const nextId = () => `b${++bankSeq}`;

/** Сводная статистика по напряжениям ячеек. */
export function cellStats(cells) {
  if (!cells || !cells.length) return null;
  let min = Infinity, max = -Infinity, sum = 0, minIndex = 0, maxIndex = 0;
  cells.forEach((v, i) => {
    sum += v;
    if (v < min) { min = v; minIndex = i; }
    if (v > max) { max = v; maxIndex = i; }
  });
  return { min, max, delta: max - min, avg: Math.round(sum / cells.length), minIndex, maxIndex, sum: Math.round(sum) };
}

export class BankManager {
  /**
   * @param {{
   *   pollMs?: number,
   *   openTransport?: (path: string) => Promise<object>,
   *   log?: (msg: string) => void,
   *   onChange?: () => void,
   * }} [opts]
   */
  constructor({ pollMs = 1000, openTransport = openSerialTransport, log = () => {}, onChange = () => {} } = {}) {
    this.banks = new Map();
    this.pollMs = pollMs;
    this.openTransport = openTransport;
    this.log = log;
    this.onChange = onChange;
    this.timer = null;
    this.polling = false;
    this.lastPollAt = 0;
  }

  // ---------- список банков ----------

  list() {
    return [...this.banks.values()];
  }

  get(id) {
    const bank = this.banks.get(id);
    if (!bank) throw bankError(404, 'NO_BANK', 'Банк не найден. Подключите его заново.');
    return bank;
  }

  /** Первый банк — для старых одиночных экранов (/api/snapshot и т. п.). */
  primary() {
    const first = [...this.banks.values()][0];
    if (!first) throw bankError(409, 'NOT_CONNECTED', 'Плата не подключена.');
    return first;
  }

  async add({ path, label = '', demo = path === 'demo', fake = null } = {}) {
    if (this.list().some((b) => b.path === path && !b.demo)) {
      throw bankError(409, 'PORT_TAKEN', `Порт ${path} уже занят другим банком.`);
    }
    const fakeProfile = demo ? { ...(DEMO_BANKS[this.banks.size % DEMO_BANKS.length] ?? {}), seed: this.banks.size, ...(fake ?? {}) } : (fake ?? {});
    const bank = {
      id: nextId(), path, label: label || defaultLabel(path, this.banks.size), demo, fakeProfile,
      transport: null, client: null, deviceName: '', connected: false,
      lastError: '', failures: 0, at: 0, basic: null, cells: null, errors: null,
      info: {}, infoAt: 0, settings: null, settingsAt: 0, history: [], spark: [],
      pendingConfirm: null,
    };
    this.banks.set(bank.id, bank);
    try {
      await this.openBank(bank);
      // первый виток сразу: панель должна получить ячейки и счётчики без ожидания таймера
      await this.pollOne(bank).catch(() => { /* дочитает цикл опроса */ });
    } catch (e) {
      this.banks.delete(bank.id);
      throw e;
    }
    this.onChange();
    return bank;
  }

  /** Открыть порт и проверить связь: базовая информация + паспорт платы. */
  async openBank(bank) {
    const transport = bank.demo ? createFakeTransport({ cellCount: 12, ...bank.fakeProfile }) : await this.openTransport(bank.path);
    const client = new BmsClient(transport, { timeoutMs: 800, retries: 2 });
    try {
      const basic = await client.readBasicInfo();
      bank.transport = transport;
      bank.client = client;
      bank.connected = true;
      bank.lastError = '';
      bank.failures = 0;
      bank.basic = basic;
      bank.at = Date.now();
      try { bank.deviceName = await client.readDeviceName(); } catch { bank.deviceName = ''; }
      await this.readInfo(bank).catch(() => { /* паспорт дочитается при опросе */ });
      return basic;
    } catch (e) {
      await client.close().catch(() => {});
      bank.connected = false;
      throw bankError(502, 'CONNECT_FAILED', `Плата на ${bank.path} не отвечает: ${e.message}`);
    }
  }

  async remove(id) {
    const bank = this.get(id);
    this.banks.delete(id);
    await closeBank(bank);
    this.onChange();
    return { removed: id };
  }

  async removeAll() {
    for (const bank of this.list()) await this.remove(bank.id);
  }

  rename(id, label) {
    const bank = this.get(id);
    bank.label = String(label || '').slice(0, 40) || defaultLabel(bank.path, 0);
    this.onChange();
    return { id, label: bank.label };
  }

  async reconnect(id) {
    const bank = this.get(id);
    await closeBank(bank);
    try {
      await this.openBank(bank);
      this.onChange();
      return { id, connected: true };
    } catch (e) {
      bank.lastError = e.message;
      this.onChange();
      throw e;
    }
  }

  /**
   * Найти все банки и подключить каждый порт, где отвечает BMS.
   * @param {{ ports: {path:string,label?:string}[], results?: object[] }} opts
   *   results — уже готовый результат сканирования (чтобы не опрашивать порты дважды)
   */
  async autoConnect({ ports, results = null, maxBanks = 16 } = {}) {
    const found = (results ?? []).filter((r) => r.found).map((r) => r.path);
    const usable = found.length ? found : ports.map((p) => p.path);
    const skipped = [];
    const added = [];
    for (const path of usable.slice(0, maxBanks)) {
      if (this.list().some((b) => b.path === path)) { skipped.push({ path, reason: 'уже подключён' }); continue; }
      try {
        const bank = await this.add({ path, label: labelForPort(ports, path) });
        added.push({ id: bank.id, path: bank.path, label: bank.label, cellCount: bank.basic?.cellCount ?? 0, deviceName: bank.deviceName });
      } catch (e) {
        skipped.push({ path, reason: e.message });
      }
    }
    return { added, skipped, found: added.map((a) => a.path) };
  }

  // ---------- опрос ----------

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.pollAll().catch(() => {}); }, this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setPollMs(ms) {
    const next = Math.max(250, Math.min(60_000, Number(ms) || 1000));
    this.pollMs = next;
    if (this.timer) { this.stop(); this.start(); }
    return this.pollMs;
  }

  async pollAll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const banks = this.list().filter((b) => b.connected);
      await Promise.all(banks.map((b) => this.pollOne(b).catch(() => {})));
      this.lastPollAt = Date.now();
    } finally {
      this.polling = false;
    }
  }

  /** Один виток опроса банка: базовая информация → ячейки → счётчики (+ паспорт по запросу). */
  async pollOne(bank, { info = false } = {}) {
    if (!bank.client) return null;
    try {
      const basic = await bank.client.readBasicInfo();
      const values = await bank.client.readCellInfo();
      let errors = null;
      try { errors = await bank.client.readErrorCounters(); } catch { /* не у всех прошивок */ }
      bank.basic = basic;
      bank.cells = { values, stats: cellStats(values) };
      bank.errors = errors;
      bank.at = Date.now();
      bank.failures = 0;
      bank.lastError = '';
      this.remember(bank);
      if (info) await this.readInfo(bank);
      return bank;
    } catch (e) {
      bank.failures++;
      bank.lastError = e.message;
      if (bank.failures >= MAX_FAILURES) {
        bank.connected = false;
        await closeBank(bank, { keepClient: false });
        this.log(`банк ${bank.label}: связь потеряна (${e.message})`);
      }
      throw e;
    }
  }

  /** Регистры паспорта (строки, версии, дата) — читаются редко, значения постоянные. */
  async readInfo(bank) {
    const info = {};
    for (const def of INFO_REGS) {
      try {
        const data = await bank.client.read(def.reg);
        info[def.key] = decodeInfo(def, data);
      } catch {
        info[def.key] = null;
      }
    }
    bank.info = info;
    bank.infoAt = Date.now();
    return info;
  }

  /** История выборок для графиков (кольцевой буфер). */
  remember(bank) {
    const b = bank.basic;
    if (!b) return;
    const st = bank.cells?.stats;
    const cells = bank.cells?.values ? [...bank.cells.values] : [];
    const sample = {
      t: bank.at,
      v: round(b.packVoltage, 2),
      a: round(b.packCurrent, 2),
      w: round(b.packVoltage * b.packCurrent, 1),
      soc: b.capacityPct,
      rem: round(b.remainingAh, 2),
      min: st?.min ?? null,
      max: st?.max ?? null,
      avg: st?.avg ?? null,
      delta: st?.delta ?? null,
      cells,
      temps: b.temperatures.map((t) => round(t, 1)),
      bal: b.balancingCells.length,
      faults: b.faultRaw,
    };
    bank.history.push(sample);
    if (bank.history.length > HISTORY_MAX) bank.history.splice(0, bank.history.length - HISTORY_MAX);
    if (bank.spark.length >= SPARK_LIMIT) bank.spark.shift();
    bank.spark.push(sample);
  }

  // ---------- отдача данных ----------

  /** Компактная строка банка для отчёта и таблицы. */
  row(bank) {
    const b = bank.basic;
    const st = bank.cells?.stats;
    return {
      id: bank.id,
      label: bank.label,
      path: bank.path,
      demo: bank.demo,
      connected: bank.connected,
      at: bank.at,
      lastError: bank.lastError,
      failures: bank.failures,
      deviceName: bank.deviceName,
      model: bank.info?.model_name ?? '',
      cellCount: b?.cellCount ?? bank.cells?.values?.length ?? 0,
      profile: bank.fakeProfile?.profile ?? '',
      voltage: b ? round(b.packVoltage, 2) : null,
      current: b ? round(b.packCurrent, 2) : null,
      power: b ? round(b.packVoltage * b.packCurrent, 1) : null,
      remainingAh: b ? round(b.remainingAh, 2) : null,
      fullAh: b ? round(b.fullAh, 2) : null,
      soc: b?.capacityPct ?? null,
      cycles: b?.cycles ?? null,
      cells: bank.cells?.values ?? [],
      stats: st ? { min: st.min, max: st.max, delta: st.delta, avg: st.avg, minIndex: st.minIndex, maxIndex: st.maxIndex, sum: st.sum } : null,
      temperatures: b?.temperatures ?? [],
      chargeFetOn: b?.chargeFetOn ?? null,
      dischargeFetOn: b?.dischargeFetOn ?? null,
      balancingCells: b?.balancingCells ?? [],
      faults: b?.faults ?? [],
      faultRaw: b?.faultRaw ?? 0,
      errors: bank.errors,
      hwVersion: bank.info?.hw_version ?? '',
      swVersion: bank.info?.sw_version ?? '',
      serial: bank.info?.serial ?? '',
      prodDate: bank.info?.prod_date ?? '',
      firmwareVersion: b?.firmwareVersion ?? null,
      spark: bank.spark.map((s) => ({ t: s.t, soc: s.soc, v: s.v, a: s.a, delta: s.delta })),
    };
  }

  /** Ряды для графика: указанный банк или агрегат по всем банкам. */
  series(bank, { seconds = 600, points = SERIES_LIMIT_DEFAULT } = {}) {
    const from = Date.now() - seconds * 1000;
    const src = bank.history.filter((s) => s.t >= from);
    const step = Math.max(1, Math.ceil(src.length / Math.max(8, points)));
    const picked = src.filter((_, i) => i % step === 0 || i === src.length - 1);
    const nTemp = Math.max(1, ...picked.map((s) => s.temps.length));
    const nCells = Math.max(0, ...picked.map((s) => (s.cells ? s.cells.length : 0)));
    const t = picked.map((s) => s.t);
    const at = (key) => picked.map((s) => s[key]);
    return {
      t,
      v: at('v'), a: at('a'), w: at('w'), soc: at('soc'), rem: at('rem'), delta: at('delta'),
      min: at('min'), max: at('max'), avg: at('avg'), bal: at('bal'), faults: at('faults'),
      cells: Array.from({ length: nCells }, (_, i) => picked.map((s) => (s.cells?.[i] ?? null))),
      temps: Array.from({ length: nTemp }, (_, i) => picked.map((s) => (s.temps[i] ?? null))),
      step,
      samples: src.length,
    };
  }

  /** Агрегат по всем банкам: ток и мощность складываются, напряжение и SOC — средние. */
  fleetSeries({ seconds = 600, points = SERIES_LIMIT_DEFAULT } = {}) {
    const banks = this.list().filter((b) => b.history.length);
    if (!banks.length) return null;
    const from = Date.now() - seconds * 1000;
    const base = banks.reduce((acc, b) => (b.history.filter((s) => s.t >= from).length > acc.len ? { len: b.history.filter((s) => s.t >= from).length, bank: b } : acc), { len: 0, bank: banks[0] }).bank;
    const samples = base.history.filter((s) => s.t >= from);
    const step = Math.max(1, Math.ceil(samples.length / Math.max(8, points)));
    const picked = samples.filter((_, i) => i % step === 0 || i === samples.length - 1);
    const at = (t0) => {
      let a = 0, w = 0, v = 0, soc = 0, delta = 0, rem = 0, n = 0, bal = 0;
      let cellMin = Infinity, cellMax = -Infinity, cellAvgSum = 0, cellAvgN = 0;
      let faults = 0;
      const temps = [null, null, null, null];
      for (const bank of banks) {
        const h = nearest(bank.history, t0);
        if (!h) continue;
        n++;
        a += h.a ?? 0;
        w += h.w ?? 0;
        v += h.v ?? 0;
        soc += h.soc ?? 0;
        delta += h.delta ?? 0;
        rem += h.rem ?? 0;
        bal += h.bal ?? 0;
        if (h.min !== null && h.min !== undefined && h.min < cellMin) cellMin = h.min;
        if (h.max !== null && h.max !== undefined && h.max > cellMax) cellMax = h.max;
        if (h.avg !== null && h.avg !== undefined) { cellAvgSum += h.avg; cellAvgN++; }
        if (h.faults) faults++;
        (h.temps ?? []).forEach((t, i) => {
          if (t === null || t === undefined) return;
          temps[i] = temps[i] === null ? t : Math.max(temps[i], t);
        });
      }
      if (!n) return null;
      return {
        a: round(a, 2), w: round(w, 1), v: round(v / n, 2), soc: round(soc / n, 1),
        delta: round(delta / n, 0), rem: round(rem, 2), bal, faults,
        min: Number.isFinite(cellMin) ? cellMin : null,
        max: Number.isFinite(cellMax) ? cellMax : null,
        avg: cellAvgN ? Math.round(cellAvgSum / cellAvgN) : null,
        temps: temps.map((t) => (t === null ? null : round(t, 1))),
      };
    };
    const rows = picked.map((s) => ({ t: s.t, ...at(s.t) })).filter((r) => r.a !== null && r.a !== undefined);
    const col = (key) => rows.map((r) => r[key]);
    return {
      t: rows.map((r) => r.t),
      v: col('v'), a: col('a'), w: col('w'), soc: col('soc'), rem: col('rem'), delta: col('delta'),
      min: col('min'), max: col('max'), avg: col('avg'), cells: [], bal: col('bal'), faults: col('faults'),
      temps: [0, 1, 2, 3].map((i) => rows.map((r) => r.temps[i])),
      step,
      samples: samples.length,
    };
  }

  /** Итоги по всему парку батарей. */
  fleet() {
    const rows = this.list().map((b) => this.row(b));
    const live = rows.filter((r) => r.connected && r.voltage !== null);
    const sum = (key) => live.reduce((acc, r) => acc + (r[key] ?? 0), 0);
    const powers = live.map((r) => Math.abs(r.power ?? 0));
    const online = live.length;
    return {
      banks: rows.length,
      online,
      stale: rows.length - online,
      voltageAvg: online ? round(live.reduce((a, r) => a + r.voltage, 0) / online, 2) : null,
      currentSum: online ? round(sum('current'), 2) : null,
      powerSum: online ? round(sum('power'), 1) : null,
      powerMax: powers.length ? round(Math.max(...powers), 1) : null,
      socAvg: online ? round(sum('soc') / online, 1) : null,
      ahSum: online ? round(sum('remainingAh'), 2) : null,
      ahCapacity: online ? round(sum('fullAh'), 2) : null,
      cellMin: online ? Math.min(...live.map((r) => r.stats?.min ?? Infinity)) : null,
      cellMax: online ? Math.max(...live.map((r) => r.stats?.max ?? -Infinity)) : null,
      cellDelta: online ? Math.max(...live.map((r) => r.stats?.delta ?? 0)) : null,
      tempMax: online ? round(Math.max(...live.flatMap((r) => r.temperatures.length ? [Math.max(...r.temperatures)] : [-999])), 1) : null,
      faults: live.reduce((a, r) => a + r.faults.length, 0),
      balancing: live.reduce((a, r) => a + r.balancingCells.length, 0),
      cyclesMax: online ? Math.max(...live.map((r) => r.cycles ?? 0)) : null,
      chargeFetOff: live.filter((r) => r.chargeFetOn === false).length,
      dischargeFetOff: live.filter((r) => r.dischargeFetOn === false).length,
    };
  }

  /** Один запрос, который кормит всю панель. */
  panel({ focus = null, seconds = 600 } = {}) {
    const rows = this.list().map((b) => this.row(b));
    const focusBank = focus && this.banks.get(focus) ? this.banks.get(focus) : this.list()[0];
    return {
      at: Date.now(),
      pollMs: this.pollMs,
      lastPollAt: this.lastPollAt,
      banks: rows,
      fleet: this.fleet(),
      focus: focusBank?.id ?? null,
      series: focusBank ? this.series(focusBank, { seconds }) : this.fleetSeries({ seconds }),
      fleetSeries: this.fleetSeries({ seconds }),
    };
  }

  // ---------- настройки: чтение и запись ----------

  /** Прочитать все описанные регистры настроек (0x10–0x47) разом. */
  async readSettings(id) {
    const bank = this.get(id ?? this.primary().id);
    if (!bank.client) throw bankError(409, 'NOT_CONNECTED', 'Банк не подключён.');
    const items = [];
    const values = {};
    const raws = {};
    for (const def of SETTINGS) {
      const lim = WRITE_LIMITS[def.key];
      const base = { key: def.key, label: def.label, unit: def.unit, reg: `0x${def.reg.toString(16).padStart(2, '0')}`, editable: Boolean(lim), group: lim?.group ?? def.group ?? 'Прочее', byte: def.byte ?? null, risky: Boolean(lim?.risky), bits: def.bits ?? null };
      if (lim) Object.assign(base, { min: lim.min, max: lim.max, step: lim.step });
      try {
        const data = await bank.client.read(def.reg);
        const value = decodeSetting(def, data);
        if (data.length >= 2) raws[def.reg] = data.readUInt16BE(0);
        values[def.key] = value;
        items.push({ ...base, value });
      } catch (e) {
        items.push({ ...base, value: null, error: e.message });
      }
    }
    bank.settings = items;
    bank.settingsAt = Date.now();
    return { at: bank.settingsAt, items, values, raws, id: bank.id };
  }

  /**
   * Запись настроек в банк. Проверяет пределы, связи порогов, «рискованные»
   * регистры и сверяет каждое значение чтением после записи.
   * @param {string} id
   * @param {{changes: Record<string, number>, confirm: boolean, password?: string, save?: boolean, risk?: boolean}} body
   */
  async writeSettings(id, body = {}) {
    const bank = this.get(id ?? this.primary().id);
    if (!bank.client) throw bankError(409, 'NOT_CONNECTED', 'Банк не подключён.');
    if (body.confirm !== true) throw bankError(400, 'NOT_CONFIRMED', 'Запись не подтверждена.');
    const changes = body.changes && typeof body.changes === 'object' ? body.changes : null;
    if (!changes) throw bankError(400, 'BAD_CHANGES', 'Не переданы изменения.');
    const keys = Object.keys(changes);
    if (!keys.length) throw bankError(400, 'NO_CHANGES', 'Нет изменений для записи.');
    if (keys.length > 80) throw bankError(400, 'TOO_MANY', 'Слишком много изменений за один раз.');

    const errors = [];
    const riskyKeys = [];
    for (const key of keys) {
      if (!WRITE_LIMITS[key]) { errors.push(`параметр «${key}» нельзя записать из приложения`); continue; }
      const value = Number(changes[key]);
      const err = checkSettingValue(key, value);
      if (err) errors.push(err);
      if (WRITE_LIMITS[key].risky) riskyKeys.push(key);
    }
    if (errors.length) throw bankError(400, 'INVALID_VALUES', errors.join('; '));
    if (riskyKeys.length && body.risk !== true) {
      throw bankError(400, 'RISK_NOT_CONFIRMED', `Нужно подтверждение риска для: ${riskyKeys.map((k) => SETTINGS.find((d) => d.key === k).label).join(', ')}.`);
    }
    let password;
    try { password = passwordBytes(typeof body.password === 'string' ? body.password : ''); } catch (e) { throw bankError(400, 'BAD_PASSWORD', e.message); }
    const save = body.save !== false;

    const { values: current, raws } = await this.readSettings(bank.id);
    const merged = { ...current };
    for (const key of keys) merged[key] = Number(changes[key]);
    const consistency = checkSettingsConsistency(merged);
    if (consistency.length) throw bankError(400, 'INCONSISTENT', consistency.join('; '));

    const toWrite = [];
    for (const key of keys) {
      const def = SETTINGS.find((d) => d.key === key);
      const raw = encodeSetting(def, Number(changes[key]), raws[def.reg] ?? null);
      const value = Number(changes[key]);
      if (raws[def.reg] !== undefined && raws[def.reg] === raw) continue; // регистр уже такое содержит
      toWrite.push({ def, value, raw });
    }
    if (!toWrite.length) {
      return { ok: true, saved: false, changed: 0, items: [], message: 'Значения уже совпадают с платой — ничего не записано.' };
    }
    try {
      await bank.client.writeSettings(toWrite.map((w) => ({ reg: w.def.reg, raw: w.raw })), { save, password: typeof body.password === 'string' ? body.password : '' });
    } catch (e) {
      throw bankError(502, 'WRITE_FAILED', `Запись не выполнена: ${e.message}. Изменения не сохранены в память платы.`);
    }
    const items = [];
    for (const w of toWrite) {
      let actual = null;
      let ok = false;
      try {
        const raw = await bank.client.readRaw(w.def);
        actual = decodeSetting(w.def, Buffer.from([raw >> 8, raw & 0xff]));
        ok = raw === w.raw;
      } catch { actual = null; }
      items.push({ key: w.def.key, label: w.def.label, unit: w.def.unit, before: current[w.def.key] ?? null, requested: w.value, actual, ok });
    }
    const allOk = items.every((i) => i.ok);
    return {
      ok: allOk, saved: save && allOk, changed: toWrite.length, items,
      message: allOk
        ? (save ? `Записано ${toWrite.length} рег. и сохранено в память платы.` : `Записано ${toWrite.length} рег. (до выключения платы).`)
        : 'Часть значений не совпала при проверке. Перечитайте настройки и повторите запись.',
    };
  }

  // ---------- команды управления ----------

  /**
   * Управление банком (или всеми банками сразу).
   * actions: fet {charge,discharge} · capacity {ah} · balance {on} · clear-errors · soc-reset · soft-reset · soc-table?
   */
  async control(id, action, payload = {}) {
    if (!CONTROL_ACTIONS.has(action)) throw bankError(400, 'BAD_ACTION', `Неизвестная команда «${action}».`);
    if (RISKY_ACTIONS.has(action) && payload.risk !== true) {
      throw bankError(400, 'RISK_NOT_CONFIRMED', `Команда «${action}» меняет состояние платы — подтвердите риск.`);
    }
    const targets = id === 'all' || payload.all ? this.list() : [this.get(id ?? this.primary().id)];
    const results = [];
    for (const bank of targets) {
      try { results.push({ id: bank.id, label: bank.label, ...(await this.controlOne(bank, action, payload)) }); }
      catch (e) { results.push({ id: bank.id, label: bank.label, ok: false, message: e.message }); }
    }
    return { action, results, ok: results.every((r) => r.ok !== false) };
  }

  async controlOne(bank, action, payload) {
    if (!bank.client) throw bankError(409, 'NOT_CONNECTED', 'Банк не подключён.');
    if (payload.confirm !== true) throw bankError(400, 'NOT_CONFIRMED', 'Действие не подтверждено.');
    switch (action) {
      case 'fet': {
        if (typeof payload.charge !== 'boolean' || typeof payload.discharge !== 'boolean') throw bankError(400, 'BAD_FLAGS', 'Укажите charge и discharge (true/false).');
        const raw = fetRaw({ charge: payload.charge, discharge: payload.discharge });
        try { await bank.client.writeSettings([{ reg: CTRL_REG.CHG_DSG_EN, raw }], { save: false }); }
        catch (e) { throw bankError(502, 'WRITE_FAILED', `Не удалось переключить ключи: ${e.message}`); }
        const basic = await bank.client.readBasicInfo();
        bank.basic = basic;
        const ok = basic.chargeFetOn === payload.charge && basic.dischargeFetOn === payload.discharge;
        return { ok, chargeFetOn: basic.chargeFetOn, dischargeFetOn: basic.dischargeFetOn, message: ok ? 'Ключи переключены.' : 'Плата показывает другое состояние ключей.' };
      }
      case 'balance': {
        const on = Boolean(payload.on);
        try { await bank.client.writeSettings([{ reg: REG.CTRL_BALANCE, raw: on ? 0x00ee : 0x0000 }], { save: false }); }
        catch (e) { throw bankError(502, 'WRITE_FAILED', `Не удалось переключить балансировку: ${e.message}`); }
        return { ok: true, balance: on, message: on ? 'Балансировка разрешена.' : 'Балансировка запрещена.' };
      }
      case 'capacity': {
        const ah = Number(payload.ah);
        let raw;
        try { raw = capRemRaw(ah); } catch (e) { throw bankError(400, 'BAD_VALUE', e.message); }
        const before = await bank.client.readBasicInfo();
        if (!(ah >= 0) || ah > before.fullAh) throw bankError(400, 'OUT_OF_RANGE', `Остаток должен быть от 0 до ${before.fullAh} Ач.`);
        try { await bank.client.writeSettings([{ reg: CTRL_REG.CAP_REM, raw }], { save: false }); }
        catch (e) { throw bankError(502, 'WRITE_FAILED', `Не удалось установить остаток: ${e.message}`); }
        const after = await bank.client.readBasicInfo();
        bank.basic = after;
        return { ok: Math.abs(after.remainingAh - ah) < 0.05, remainingAh: after.remainingAh, fullAh: after.fullAh };
      }
      case 'clear-errors': {
        try { await bank.client.writeSettings([], { save: true, password: payload.password ?? '' }); }
        catch (e) { throw bankError(502, 'WRITE_FAILED', `Не удалось сбросить счётчики: ${e.message}`); }
        const errors = await bank.client.readErrorCounters();
        bank.errors = errors;
        const nonZero = Object.values(errors).some((v) => v !== 0);
        return { ok: !nonZero, errors, message: nonZero ? 'Часть счётчиков не обнулилась.' : 'Счётчики ошибок сброшены.' };
      }
      case 'soc-reset': {
        if (payload.risk !== true) throw bankError(400, 'RISK_NOT_CONFIRMED', 'Пересчёт SOC меняет показания остатка — подтвердите риск.');
        try { await bank.client.write(CTRL_REG.CAP_REM === 0 ? 0 : REG.CTRL_SOC_RESET, [0x18, 0x81]); }
        catch (e) { throw bankError(502, 'WRITE_FAILED', `Пересчёт SOC не выполнен: ${e.message}`); }
        return { ok: true, message: 'Команда пересчёта SOC отправлена.' };
      }
      case 'soft-reset': {
        if (payload.risk !== true) throw bankError(400, 'RISK_NOT_CONFIRMED', 'Перезагрузка платы прервёт связь — подтвердите риск.');
        try { await bank.client.write(REG.CTRL_RESET, [0x43, 0x21]); }
        catch (e) { throw bankError(502, 'WRITE_FAILED', `Команда перезагрузки не выполнена: ${e.message}`); }
        return { ok: true, message: 'Команда перезагрузки отправлена. Плата на несколько секунд отключится.' };
      }
      default:
        throw bankError(400, 'BAD_ACTION', `Неизвестная команда «${action}».`);
    }
  }

  // ---------- сырые регистры (консоль) ----------

  /** Пакетное чтение регистров: regs — массив чисел. */
  async rawRead(id, regs = []) {
    const bank = this.get(id ?? this.primary().id);
    if (!bank.client) throw bankError(409, 'NOT_CONNECTED', 'Банк не подключён.');
    const list = regs.slice(0, 160).map((r) => Number(r)).filter((r) => Number.isInteger(r) && r >= 0 && r <= 0xff);
    const out = [];
    for (const reg of list) {
      const item = { reg, hex: `0x${reg.toString(16).toUpperCase().padStart(2, '0')}`, ok: false, bytes: [], text: '', u16: null, temp: null, error: '' };
      try {
        const data = await bank.client.read(reg);
        item.ok = true;
        item.bytes = Array.from(data, (b) => b.toString(16).padStart(2, '0').toUpperCase());
        item.u16 = data.length >= 2 ? data.readUInt16BE(0) : null;
        item.temp = data.length >= 2 ? decodeTemp(data.readUInt16BE(0)) : null;
        item.text = printable(data);
        item.length = data.length;
      } catch (e) { item.error = e.message; }
      out.push(item);
    }
    return { at: Date.now(), id: bank.id, items: out };
  }

  /**
   * Сырая запись: один регистр, 1 или 2 байта, по желанию — через заводской режим.
   * Нужны confirm (и risk, если регистр помечен опасным).
   */
  async rawWrite(id, { reg, bytes, raw = null, factory = true, password = '', confirm = false, risk = false } = {}) {
    const bank = this.get(id ?? this.primary().id);
    if (!bank.client) throw bankError(409, 'NOT_CONNECTED', 'Банк не подключён.');
    if (confirm !== true) throw bankError(400, 'NOT_CONFIRMED', 'Запись не подтверждена.');
    const regNum = Number(reg);
    if (!Number.isInteger(regNum) || regNum < 0 || regNum > 0xff) throw bankError(400, 'BAD_REG', 'Регистр — число 0x00…0xFF.');
    const catalogItem = bankCatalog()[regNum];
    if (catalogItem?.risky && risk !== true) throw bankError(400, 'RISK_NOT_CONFIRMED', `Регистр ${hex(regNum)} помечен как опасный: подтвердите риск.`);
    let data;
    if (Array.isArray(bytes)) {
      if (!bytes.length || bytes.length > 32) throw bankError(400, 'BAD_BYTES', 'Длина данных — 1…32 байта.');
      data = bytes.map((b) => Number(b));
      if (data.some((b) => !Number.isInteger(b) || b < 0 || b > 0xff)) throw bankError(400, 'BAD_BYTES', 'Байты — целые 0…255.');
    } else if (raw !== null && raw !== undefined) {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw bankError(400, 'BAD_RAW', 'Значение регистра — целое 0…65535.');
      data = [(value >> 8) & 0xff, value & 0xff];
    } else throw bankError(400, 'NO_DATA', 'Нужны байты или значение регистра.');

    try { passwordBytes(password); } catch (e) { throw bankError(400, 'BAD_PASSWORD', e.message); }
    try {
      if (factory) await bank.client.writeSettings([{ reg: regNum, raw: (data[0] << 8) | (data[1] ?? 0) }], { save: false, password });
      else await bank.client.write(regNum, data);
    } catch (e) {
      throw bankError(502, 'WRITE_FAILED', `Запись не выполнена: ${e.message}`);
    }
    let read = null;
    try {
      const data2 = await bank.client.read(regNum);
      read = { bytes: Array.from(data2, (b) => b.toString(16).padStart(2, '0').toUpperCase()), u16: data2.length >= 2 ? data2.readUInt16BE(0) : null };
    } catch { /* регистр может не читаться (только запись) */ }
    return { ok: true, reg: regNum, hex: hex(regNum), sent: data, read, message: read ? 'Записано. Чтение обратно: ' + (read.bytes ?? []).join(' ') : 'Записано (этот регистр не читается).' };
  }

  // ---------- отчёт ----------

  /** Полный отчёт по всем банкам: всё, что удалось прочитать. */
  async report({ id = null, settings = true } = {}) {
    const banks = id ? [this.get(id)] : this.list();
    const rows = [];
    for (const bank of banks) {
      const row = this.row(bank);
      row.info = bank.info;
      row.infoAt = bank.infoAt;
      if (settings && bank.client) {
        try { row.settings = (await this.readSettings(bank.id)).items; } catch { row.settings = null; }
      } else row.settings = bank.settings;
      rows.push(row);
    }
    return { at: Date.now(), app: 'jbd-bms', fleet: this.fleet(), banks: rows };
  }

  /** CSV для отчёта: строка на банк + блоки настроек (разделитель — точка с запятой, как любит Excel с RU). */
  csv() {
    const rows = this.list().map((b) => this.row(b));
    const head = [
      'Банк', 'Порт', 'Имя платы', 'Модель', 'Статус', 'Обновлено', 'Напряжение В', 'Ток А', 'Мощность Вт',
      'Остаток Ач', 'Полная Ач', 'SOC %', 'Циклов', 'Ячеек', 'Мин мВ', 'Макс мВ', 'Разброс мВ',
      'Среднее мВ', 'T1 °C', 'T2 °C', 'T3 °C', 'T4 °C', 'Ключ заряда', 'Ключ разряда', 'Баланс ячеек', 'Защиты', 'HW', 'SW', 'Серийный',
    ];
    const lines = [head.join(';')];
    for (const r of rows) {
      lines.push([
        r.label, r.path, r.deviceName, r.model, r.connected ? 'онлайн' : 'нет связи',
        r.at ? new Date(r.at).toISOString() : '', num(r.voltage), num(r.current), num(r.power),
        num(r.remainingAh), num(r.fullAh), num(r.soc), r.cycles ?? '', r.cells.length,
        r.stats?.min ?? '', r.stats?.max ?? '', r.stats?.delta ?? '', r.stats?.avg ?? '',
        ...[0, 1, 2, 3].map((i) => num(r.temperatures[i])),
        r.chargeFetOn === null ? '' : r.chargeFetOn ? 'вкл' : 'выкл',
        r.dischargeFetOn === null ? '' : r.dischargeFetOn ? 'вкл' : 'выкл',
        r.balancingCells.join('+'), r.faults.map((f) => f.label).join(' + ') || 'нет',
        r.hwVersion, r.swVersion, r.serial,
      ].join(';'));
    }
    for (const bank of this.list()) {
      if (!bank.settings?.length) continue;
      lines.push('');
      lines.push(`Настройки; ${bank.label}; ${bank.path}`);
      lines.push('Параметр; Регистр; Значение; Ед.; Доступно');
      for (const it of bank.settings) {
        lines.push([it.label, it.reg, typeof it.value === 'number' ? num(it.value) : (it.value ?? '—'), it.unit, it.error ? 'нет ответа' : it.editable ? 'чтение/запись' : 'чтение'].join(';'));
      }
    }
    return lines.join('\r\n');
  }

  /** Резервная копия всех настроек банка. */
  async backup(id) {
    const bank = this.get(id ?? this.primary().id);
    const { items } = await this.readSettings(bank.id);
    const out = {};
    for (const it of items) if (it.value !== null && it.value !== undefined) out[it.key] = it.value;
    return {
      app: 'jbd-bms', kind: 'backup', at: new Date().toISOString(),
      bank: { id: bank.id, label: bank.label, port: bank.path, deviceName: bank.deviceName },
      items: out,
    };
  }

  /** Восстановление из резервной копии: сверяет ключи, пропускает неизвестные и неизменяемые. */
  async restore(id, body = {}) {
    const bank = this.get(id ?? this.primary().id);
    const file = body.items && typeof body.items === 'object' ? body.items : null;
    if (!file) throw bankError(400, 'BAD_FILE', 'В файле копии нет блока items.');
    const writable = new Set(SETTINGS.filter((d) => WRITE_LIMITS[d.key]).map((d) => d.key));
    const changes = {};
    const skipped = [];
    for (const [key, value] of Object.entries(file)) {
      if (!writable.has(key)) { skipped.push({ key, reason: 'нельзя записать из приложения' }); continue; }
      const err = checkSettingValue(key, Number(value));
      if (err) { skipped.push({ key, reason: err }); continue; }
      changes[key] = Number(value);
    }
    const { values: current } = await this.readSettings(bank.id);
    const diff = Object.entries(changes)
      .filter(([key, value]) => Number(current[key]) !== Number(value))
      .map(([key, value]) => ({ key, label: SETTINGS.find((d) => d.key === key).label, unit: SETTINGS.find((d) => d.key === key).unit, before: current[key] ?? null, after: value }));
    if (body.dryRun !== false) {
      return { dryRun: true, changes: diff, skipped, same: Object.keys(changes).length - diff.length };
    }
    if (!diff.length) return { ok: true, saved: false, changed: 0, items: [], message: 'Копия совпадает с платой — ничего не записано.' };
    return this.writeSettings(bank.id, { confirm: body.confirm, changes, save: body.save, password: body.password, risk: body.risk });
  }
}

// ---------- вспомогательное ----------

function bankError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

async function closeBank(bank, { keepClient = false } = {}) {
  const client = bank.client;
  const transport = bank.transport;
  if (!keepClient) { bank.client = null; bank.transport = null; }
  bank.connected = false;
  try { if (client) await client.close(); else if (transport) await transport.close(); } catch { /* порт уже закрыт */ }
}

function defaultLabel(path, index) {
  if (path === 'demo') return `ДЕМО ${index + 1}`;
  return String(path).replace(/^\/dev\//, '').toUpperCase();
}

function labelForPort(ports, path) {
  const p = ports.find((x) => x.path === path);
  if (!p?.label) return '';
  return p.label.replace(`${path} · `, '').slice(0, 24);
}

function round(v, digits) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

const num = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));

function nearest(list, t) {
  if (!list.length) return null;
  let best = null;
  let bestDt = Infinity;
  for (const s of list) {
    const dt = Math.abs(s.t - t);
    if (dt < bestDt) { bestDt = dt; best = s; }
  }
  return bestDt > 5000 ? null : best;
}

function printable(buf) {
  const text = buf.toString('utf8').replace(/\0+/g, ' ').trim();
  return /^[\x20-\x7e\xd0-\xff\s]{3,}$/u.test(text) && text.length >= 3 ? text : '';
}

const hex = (n) => `0x${Number(n).toString(16).toUpperCase().padStart(2, '0')}`;

let catalogCache = null;
/** Карта «регистр → описание» для проверки опасных записей в консоли. */
export function bankCatalog() {
  if (catalogCache) return catalogCache;
  catalogCache = {};
  for (const item of REG_CATALOG) {
    const prev = catalogCache[item.reg];
    catalogCache[item.reg] = prev ? { ...prev, ...item, risky: Boolean(prev.risky || item.risky) } : item;
  }
  return catalogCache;
}

export { bankError };
