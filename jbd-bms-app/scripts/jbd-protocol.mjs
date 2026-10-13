// Протокол JBD (Jiabaida / Xiaoxiang / Overkill Solar) по UART: 9600 8N1.
//
// Кадр:  DD | команда(A5 чтение / 5A запись) | регистр | длина | данные… | КС_H КС_L | 77
// Ответ: DD | регистр | статус (00 — ок, 80 — ошибка) | длина | данные… | КС_H КС_L | 77
//
// Контрольная сумма = 0x10000 − сумма байтов (старший байт первым).
//   • запрос:  сумма «регистр + длина + данные»;
//   • ответ:   сумма «статус + длина + данные» (проверяем и вариант без статуса).
// Пример из документации JBD: DD A5 03 00 FF FD 77 — запрос базовой информации.
//
// Описание регистров и формат данных сверены с открытой библиотекой bms-tools
// (MrSurly, GPL-3.0; bmstools/jbd/jbd.py и registers.py) и с документом JBD Protocol V4.
// Модуль без зависимостей и без ввода-вывода: его можно тестировать отдельно.

export const START = 0xdd;
export const END = 0x77;
export const OP_READ = 0xa5;
export const OP_WRITE = 0x5a;

export const REG = {
  BASIC_INFO: 0x03,
  CELL_INFO: 0x04,
  DEVICE_NAME: 0x05,
  ERROR_COUNTS: 0xaa,
  // регистры настроек (EEPROM), читаются без пароля (диапазон 0x10–0x3F)
  DESIGN_CAP: 0x10,
  CYCLE_CAP: 0x11,
  CHGOT: 0x18,
  CHGOT_REL: 0x19,
  CHGUT: 0x1a,
  CHGUT_REL: 0x1b,
  DSGOT: 0x1c,
  DSGOT_REL: 0x1d,
  DSGUT: 0x1e,
  DSGUT_REL: 0x1f,
  POVP: 0x20,
  POVP_REL: 0x21,
  PUVP: 0x22,
  PUVP_REL: 0x23,
  COVP: 0x24,
  COVP_REL: 0x25,
  CUVP: 0x26,
  CUVP_REL: 0x27,
  CHGOC: 0x28,
  DSGOC: 0x29,
  BAL_START: 0x2a,
  BAL_WINDOW: 0x2b,
  CELL_CNT: 0x2f,
};

/** Какие настройки показываем на вкладке «Защиты». Масштаб — как в bms-tools. */
export const SETTINGS = [
  { reg: REG.COVP, key: 'covp', label: 'Перенапряжение ячейки (OVP)', unit: 'мВ', kind: 'mv', scale: 1 },
  { reg: REG.COVP_REL, key: 'covp_rel', label: 'Возврат после перенапряжения', unit: 'мВ', kind: 'mv', scale: 1 },
  { reg: REG.CUVP, key: 'cuvp', label: 'Понижение напряжения ячейки (UVP)', unit: 'мВ', kind: 'mv', scale: 1 },
  { reg: REG.CUVP_REL, key: 'cuvp_rel', label: 'Возврат после понижения', unit: 'мВ', kind: 'mv', scale: 1 },
  { reg: REG.POVP, key: 'povp', label: 'Перенапряжение батареи', unit: 'мВ', kind: 'mv', scale: 10 },
  { reg: REG.POVP_REL, key: 'povp_rel', label: 'Возврат после перенапряжения батареи', unit: 'мВ', kind: 'mv', scale: 10 },
  { reg: REG.PUVP, key: 'puvp', label: 'Понижение напряжения батареи', unit: 'мВ', kind: 'mv', scale: 10 },
  { reg: REG.PUVP_REL, key: 'puvp_rel', label: 'Возврат после понижения батареи', unit: 'мВ', kind: 'mv', scale: 10 },
  { reg: REG.CHGOC, key: 'chgoc', label: 'Перегрузка по заряду', unit: 'мА', kind: 'ma', scale: 10 },
  { reg: REG.DSGOC, key: 'dsgoc', label: 'Перегрузка по разряду', unit: 'мА', kind: 'ma', scale: 10 },
  { reg: REG.CHGOT, key: 'chgot', label: 'Перегрев при заряде', unit: '°C', kind: 'temp' },
  { reg: REG.CHGOT_REL, key: 'chgot_rel', label: 'Возврат после перегрева при заряде', unit: '°C', kind: 'temp' },
  { reg: REG.CHGUT, key: 'chgut', label: 'Переохлаждение при заряде', unit: '°C', kind: 'temp' },
  { reg: REG.CHGUT_REL, key: 'chgut_rel', label: 'Возврат после переохлаждения при заряде', unit: '°C', kind: 'temp' },
  { reg: REG.DSGOT, key: 'dsgot', label: 'Перегрев при разряде', unit: '°C', kind: 'temp' },
  { reg: REG.DSGOT_REL, key: 'dsgot_rel', label: 'Возврат после перегрева при разряде', unit: '°C', kind: 'temp' },
  { reg: REG.DSGUT, key: 'dsgut', label: 'Переохлаждение при разряде', unit: '°C', kind: 'temp' },
  { reg: REG.DSGUT_REL, key: 'dsgut_rel', label: 'Возврат после переохлаждения при разряде', unit: '°C', kind: 'temp' },
  { reg: REG.BAL_START, key: 'bal_start', label: 'Старт балансировки', unit: 'мВ', kind: 'mv', scale: 1 },
  { reg: REG.BAL_WINDOW, key: 'bal_window', label: 'Окно балансировки', unit: 'мВ', kind: 'mv', scale: 1 },
  { reg: REG.DESIGN_CAP, key: 'design_cap', label: 'Номинальная ёмкость', unit: 'мАч', kind: 'mah', scale: 10 },
  { reg: REG.CELL_CNT, key: 'cell_cnt', label: 'Число ячеек (настройка)', unit: 'шт', kind: 'count', scale: 1 },
];

/** Защиты (бит регистра 0x0000 «состояние», порядок как в bms-tools). */
export const FAULT_BITS = [
  { bit: 0, key: 'covp', label: 'Перенапряжение ячейки' },
  { bit: 1, key: 'cuvp', label: 'Понижение напряжения ячейки' },
  { bit: 2, key: 'povp', label: 'Перенапряжение батареи' },
  { bit: 3, key: 'puvp', label: 'Понижение напряжения батареи' },
  { bit: 4, key: 'chgot', label: 'Перегрев при заряде' },
  { bit: 5, key: 'chgut', label: 'Переохлаждение при заряде' },
  { bit: 6, key: 'dsgot', label: 'Перегрев при разряде' },
  { bit: 7, key: 'dsgut', label: 'Переохлаждение при разряде' },
  { bit: 8, key: 'chgoc', label: 'Перегрузка по заряду' },
  { bit: 9, key: 'dsgoc', label: 'Перегрузка по разряду' },
  { bit: 10, key: 'sc', label: 'Короткое замыкание' },
  { bit: 11, key: 'afe', label: 'Ошибка измерительной микросхемы (AFE)' },
  { bit: 12, key: 'software', label: 'Программная защита' },
];

/** Счётчики ошибок (регистр 0xAA), порядок как в bms-tools. */
export const ERROR_COUNTER_NAMES = [
  ['sc', 'Короткое замыкание'], ['chgoc', 'Перегрузка заряда'], ['dsgoc', 'Перегрузка разряда'],
  ['covp', 'Перенапряжение ячейки'], ['cuvp', 'Понижение ячейки'],
  ['chgot', 'Перегрев заряда'], ['chgut', 'Переохлаждение заряда'],
  ['dsgot', 'Перегрев разряда'], ['dsgut', 'Переохлаждение разряда'],
  ['povp', 'Перенапряжение батареи'], ['puvp', 'Понижение батареи'],
];

export class BmsProtocolError extends Error {}

/** 0x10000 − сумма байтов, mod 2^16. */
export function checksum(bytes) {
  let sum = 0;
  for (const b of bytes) sum += b;
  return (0x10000 - sum) & 0xffff;
}

/** Кадр запроса чтения регистра. */
export function buildReadFrame(reg, data = []) {
  return buildFrame(OP_READ, reg, data);
}

/** Кадр записи регистра (используется только при явной записи настроек). */
export function buildWriteFrame(reg, data = []) {
  return buildFrame(OP_WRITE, reg, data);
}

function buildFrame(op, reg, data) {
  if (data.length > 0xff) throw new BmsProtocolError('слишком длинные данные кадра');
  const payload = [reg, data.length, ...data];
  const cs = checksum(payload);
  return Buffer.from([START, op, ...payload, cs >> 8, cs & 0xff, END]);
}

/** Кадр ответа BMS (для эмулятора и тестов): контрольная сумма по «статус + длина + данные». */
export function buildFrameForResponse(reg, status, data) {
  const body = [status, data.length, ...data];
  const cs = checksum(body);
  return Buffer.from([START, reg, ...body, cs >> 8, cs & 0xff, END]);
}

/**
 * Достаёт из буфера все полные кадры ответа. Мусор до 0xDD и кадры с
 * неверной контрольной суммой пропускаются (поиск синхронизации продолжается).
 * Возвращает { frames: [{reg, status, data}], rest } — rest хранит неполный хвост.
 */
export function extractResponses(buffer) {
  const frames = [];
  let i = 0;
  const buf = Buffer.from(buffer);
  while (i < buf.length) {
    if (buf[i] !== START) { i++; continue; }
    if (buf.length - i < 7) break; // ещё не пришёл минимальный кадр
    const len = buf[i + 3];
    const total = len + 7;
    if (buf.length - i < total) break; // ждём остаток кадра
    const frame = buf.subarray(i, i + total);
    if (frame[total - 1] !== END) { i++; continue; }
    const got = (frame[total - 3] << 8) | frame[total - 2];
    const dataEnd = total - 3;
    // сумма статус+длина+данные (основной вариант) или длина+данные (без статуса)
    const withStatus = (0x10000 - sumRange(frame, 2, dataEnd)) & 0xffff;
    const withoutStatus = (0x10000 - sumRange(frame, 3, dataEnd)) & 0xffff;
    if (got !== withStatus && got !== withoutStatus) { i++; continue; }
    frames.push({
      reg: frame[1],
      status: frame[2],
      data: Buffer.from(frame.subarray(4, 4 + len)),
    });
    i += total;
  }
  return { frames, rest: buf.subarray(i) };
}

function sumRange(buf, from, to) {
  let s = 0;
  for (let k = from; k < to; k++) s += buf[k];
  return s;
}

// ---------- разбор данных ----------

/** Температура в регистре: десятые кельвина. (raw − 2731) / 10 → °C. */
export function decodeTemp(raw) {
  return Math.round(((raw - 2731) / 10) * 10) / 10;
}

/** Дата производства: биты 0–4 день, 5–8 месяц, 9–15 год от 2000. */
export function decodeDate(raw) {
  const day = raw & 0x1f;
  const month = (raw >> 5) & 0x0f;
  const year = ((raw >> 9) & 0x7f) + 2000;
  return { year, month, day };
}

/** Регистр 0x03 — общее состояние батареи. */
export function parseBasicInfo(data) {
  if (data.length < 23) throw new BmsProtocolError(`базовая информация короче ожидаемого: ${data.length} байт`);
  const packRaw = data.readUInt16BE(0);
  const packMaRaw = data.readInt16BE(2);
  const curCap = data.readUInt16BE(4);
  const fullCap = data.readUInt16BE(6);
  const cycles = data.readUInt16BE(8);
  const date = decodeDate(data.readUInt16BE(10));
  const bal0 = data.readUInt16BE(12);
  const bal1 = data.readUInt16BE(14);
  const faultRaw = data.readUInt16BE(16);
  const version = data[18];
  const capPct = data[19];
  const fet = data[20];
  const cellCount = data[21];
  const ntcCount = data[22];

  const balanceMask = (bal0 | (bal1 << 16)) >>> 0;
  const balancingCells = [];
  for (let i = 0; i < 32; i++) if (balanceMask & (1 << i)) balancingCells.push(i + 1);

  const ntcTemps = [];
  for (let i = 0; i < ntcCount; i++) {
    const off = 23 + i * 2;
    if (off + 2 > data.length) break;
    ntcTemps.push(decodeTemp(data.readUInt16BE(off)));
  }

  const faults = FAULT_BITS.filter((f) => faultRaw & (1 << f.bit)).map((f) => ({ key: f.key, label: f.label }));

  return {
    packVoltage: packRaw * 10 / 1000,        // В
    packCurrent: packMaRaw * 10 / 1000,      // А (знак: минус — разряд)
    remainingAh: curCap * 10 / 1000,         // Ач
    fullAh: fullCap * 10 / 1000,             // Ач
    capacityPct: capPct,                     // %
    cycles,
    manufactureDate: date,
    cellCount,
    ntcCount,
    temperatures: ntcTemps,                  // °C
    chargeFetOn: Boolean(fet & 0x01),
    dischargeFetOn: Boolean(fet & 0x02),
    balancingCells,
    faults,
    faultRaw,
    firmwareVersion: version,
  };
}

/** Регистр 0x04 — напряжения ячеек, мВ (по две байта, старший первым). */
export function parseCellInfo(data) {
  const count = Math.floor(data.length / 2);
  const cells = [];
  for (let i = 0; i < count; i++) cells.push(data.readUInt16BE(i * 2));
  return cells;
}

/** Регистр 0x05 — имя устройства (ASCII). */
export function parseDeviceName(data) {
  return data.toString('utf8').replace(/\0+/g, '').trim();
}

/** Регистр 0xAA — счётчики ошибок (по одному u16 на счётчик). */
export function parseErrorCounters(data) {
  const out = {};
  ERROR_COUNTER_NAMES.forEach(([key], i) => {
    out[key] = i * 2 + 2 <= data.length ? data.readUInt16BE(i * 2) : 0;
  });
  return out;
}

/** Значение настройки из сырого u16 с учётом масштаба. */
export function decodeSetting(def, data) {
  if (data.length < 2) return null;
  const raw = data.readUInt16BE(0);
  if (def.kind === 'temp') return decodeTemp(raw);
  return raw * (def.scale ?? 1);
}

// ---------- запись настроек ----------
//
// Запись выполняется только в «заводском режиме» (как в bms-tools):
//   1) регистр 0x06 — пароль (6 байт, по умолчанию нули);
//   2) регистр 0x00 — вход: 56 78;
//   3) регистры настроек — 2 байта BE, каждый;
//   4) регистр 0x01 — выход: 28 28 (сохранить в память платы) или 00 00 (только до выключения).
// Пределы ниже — в единицах, которые видит пользователь (мВ, мА, мАч, °C).

export const WRITE_REG = { PASSWORD: 0x06, FACTORY: 0x00, EXIT: 0x01 };
export const FACTORY_ENTER = [0x56, 0x78];
export const FACTORY_EXIT_SAVE = [0x28, 0x28];
export const FACTORY_EXIT_DISCARD = [0x00, 0x00];

/** Пределы записываемых настроек. Ключ — key из SETTINGS. cell_cnt намеренно не записывается. */
export const WRITE_LIMITS = {
  design_cap: { group: 'Ёмкость', min: 1000, max: 500000, step: 10 },
  covp: { group: 'Напряжение ячейки', min: 2500, max: 4250, step: 1 },
  covp_rel: { group: 'Напряжение ячейки', min: 2500, max: 4250, step: 1 },
  cuvp: { group: 'Напряжение ячейки', min: 1500, max: 3650, step: 1 },
  cuvp_rel: { group: 'Напряжение ячейки', min: 1500, max: 3800, step: 1 },
  povp: { group: 'Напряжение батареи', min: 5000, max: 60000, step: 10 },
  povp_rel: { group: 'Напряжение батареи', min: 5000, max: 60000, step: 10 },
  puvp: { group: 'Напряжение батареи', min: 5000, max: 60000, step: 10 },
  puvp_rel: { group: 'Напряжение батареи', min: 5000, max: 60000, step: 10 },
  chgoc: { group: 'Токи', min: 1000, max: 200000, step: 10 },
  dsgoc: { group: 'Токи', min: 1000, max: 300000, step: 10 },
  chgot: { group: 'Температура', min: -20, max: 80, step: 0.1 },
  chgot_rel: { group: 'Температура', min: -20, max: 80, step: 0.1 },
  chgut: { group: 'Температура', min: -30, max: 60, step: 0.1 },
  chgut_rel: { group: 'Температура', min: -30, max: 60, step: 0.1 },
  dsgot: { group: 'Температура', min: -20, max: 90, step: 0.1 },
  dsgot_rel: { group: 'Температура', min: -20, max: 90, step: 0.1 },
  dsgut: { group: 'Температура', min: -30, max: 60, step: 0.1 },
  dsgut_rel: { group: 'Температура', min: -30, max: 60, step: 0.1 },
  bal_start: { group: 'Балансировка', min: 1000, max: 4250, step: 1 },
  bal_window: { group: 'Балансировка', min: 1, max: 500, step: 1 },
};

/** Пары «срабатывание/возврат» и прочие связи: [ключ_a, оператор, ключ_b, текст]. */
const CONSISTENCY_RULES = [
  ['covp', '>', 'covp_rel', 'перенапряжение ячейки должно быть выше возврата'],
  ['cuvp_rel', '>', 'cuvp', 'возврат после понижения ячейки должен быть выше порога'],
  ['covp', '>', 'cuvp', 'перенапряжение ячейки должно быть выше понижения'],
  ['povp', '>', 'povp_rel', 'перенапряжение батареи должно быть выше возврата'],
  ['puvp_rel', '>', 'puvp', 'возврат после понижения батареи должен быть выше порога'],
  ['povp', '>', 'puvp', 'перенапряжение батареи должно быть выше понижения'],
  ['chgot', '>', 'chgot_rel', 'перегрев при заряде должен быть выше возврата'],
  ['chgut_rel', '>', 'chgut', 'возврат после переохлаждения при заряде должен быть выше порога'],
  ['dsgot', '>', 'dsgot_rel', 'перегрев при разряде должен быть выше возврата'],
  ['dsgut_rel', '>', 'dsgut', 'возврат после переохлаждения при разряде должен быть выше порога'],
  ['chgot', '>', 'chgut', 'перегрев при заряде должен быть выше переохлаждения'],
  ['dsgot', '>', 'dsgut', 'перегрев при разряде должен быть выше переохлаждения'],
  ['bal_start', '>', 'bal_window', 'старт балансировки должен быть выше окна'],
];

const SETTINGS_BY_KEY = Object.fromEntries(SETTINGS.map((d) => [d.key, d]));

/** Описание записываемых настроек для интерфейса. */
export function writableDefs() {
  return SETTINGS.filter((d) => WRITE_LIMITS[d.key]).map((d) => ({ ...d, ...WRITE_LIMITS[d.key] }));
}

/** Проверка одного значения: текст ошибки или null. */
export function checkSettingValue(key, value) {
  const def = SETTINGS_BY_KEY[key];
  const lim = WRITE_LIMITS[key];
  if (!def || !lim) return `параметр «${key}» нельзя записать`;
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${def.label}: введите число`;
  if (value < lim.min || value > lim.max) return `${def.label}: допустимо от ${lim.min} до ${lim.max} ${def.unit}`;
  try {
    settingToRaw(def, value);
  } catch (e) {
    return e.message;
  }
  return null;
}

/** Значение → сырое 16-битное значение регистра. Ошибка, если значение не кратно разрешению регистра. */
export function settingToRaw(def, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) throw new BmsProtocolError(`${def.label}: значение не число`);
  let exact;
  if (def.kind === 'temp') exact = v * 10 + 2731;
  else if (def.kind === 'count') exact = v;
  else exact = v / (def.scale ?? 1);
  const raw = Math.round(exact);
  if (Math.abs(exact - raw) > 1e-6) {
    const res = def.kind === 'temp' ? '0,1 °C' : `${def.scale ?? 1} ${def.unit}`;
    throw new BmsProtocolError(`${def.label}: шаг регистра — ${res}`);
  }
  if (raw < 0 || raw > 0xffff) throw new BmsProtocolError(`${def.label}: значение не помещается в регистр`);
  return raw;
}

/** Проверка связей между порогами. values — { ключ: значение в единицах интерфейса }; берём только известные. */
export function checkSettingsConsistency(values) {
  const errors = [];
  for (const [a, op, b, text] of CONSISTENCY_RULES) {
    if (values[a] === undefined || values[b] === undefined) continue;
    const ok = op === '>' ? values[a] > values[b] : values[a] < values[b];
    if (!ok) errors.push(`${SETTINGS_BY_KEY[a]?.label ?? a} (${values[a]}) и ${SETTINGS_BY_KEY[b]?.label ?? b} (${values[b]}): ${text}`);
  }
  return errors;
}

/** Пароль платы: пусто (нули) или ровно 6 символов ASCII. */
export function passwordBytes(password = '') {
  const out = Buffer.alloc(6);
  if (!password) return out;
  if (!/^[\x20-\x7e]{6}$/.test(password)) throw new BmsProtocolError('пароль платы — ровно 6 символов ASCII');
  Buffer.from(password, 'ascii').copy(out);
  return out;
}
