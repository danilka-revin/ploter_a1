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
  // регистры настроек (EEPROM), читаются без пароля (диапазон 0x10–0x47)
  DESIGN_CAP: 0x10,
  CYCLE_CAP: 0x11,
  // ---------- сведения о плате (только чтение) ----------
  STATUS: 0x00,           // биты активных защит (то же, что в 0x03)
  HW_VERSION: 0x06,       // версия аппаратной части, строка
  SW_VERSION: 0x07,       // версия прошивки, строка
  PROD_DATE: 0x08,        // дата производства: год−2000, месяц, день
  SERIAL: 0x09,           // серийный номер (байты)
  LIFE_CAP: 0x0a,         // суммарная ёмкость за срок службы (единица 1000 мАч)
  MFG_NAME: 0xa0,         // изготовитель, строка
  MODEL_NAME: 0xa1,       // модель устройства, строка
  BARCODE: 0xa2,          // штрихкод/паспорт, строка
  // ---------- прочие регистры EEPROM ----------
  SOC_FULL: 0x12,         // напряжение ячейки, при котором плата считает 100 % (SOC1)
  SOC_EMPTY: 0x13,        // напряжение ячейки для 0 % (SOC0)
  SMALL_CUR: 0x14,        // ток малого заряда / порог «нет тока» (мА)
  MFG_DATE_EE: 0x15,      // дата производства в EEPROM (биты, как в 0x03)
  SERIAL_EE: 0x16,        // серийный номер в EEPROM
  CYCLE_CNT: 0x17,        // число циклов в EEPROM
  CUR_SHUNT: 0x2c,        // сопротивление шунта датчика тока (мкОм)
  FUNC_MASK: 0x2d,        // функции платы (баланс, LED, RTC, ключ…)
  NTC_MASK: 0x2e,         // какие датчики температуры подключены
  FET_OFF_TIME: 0x30,     // сколько секунд ключи остаются выключены после защиты
  LED_TIME: 0x31,         // время индикации светодиодами (с)
  SOC_80: 0x32, SOC_60: 0x33, SOC_40: 0x34, SOC_20: 0x35,
  HW_COVP: 0x36,          // аппаратное перенапряжение ячейки
  HW_CUVP: 0x37,          // аппаратное понижение напряжения ячейки
  HW_OC: 0x38,            // аппаратная перегрузка / короткое замыкание
  HW_DELAY: 0x39,         // задержка аппаратных защит / отпускание КЗ
  CHG_DELAY: 0x3a,        // задержки защит по заряду (младший байт — возврат)
  DSG_DELAY: 0x3b,        // задержки защит по разряду
  PACK_DELAY: 0x3c,       // задержки по напряжению батареи
  CELL_DELAY: 0x3d,       // задержки по напряжению ячейки
  CHG_OC_DELAY: 0x3e,     // задержка и возврат по перегрузке заряда
  DSG_OC_DELAY: 0x3f,     // задержка и возврат по перегрузке разряда
  GPS_VOL: 0x40, GPS_TIME: 0x41,
  SOC_90: 0x42, SOC_70: 0x43, SOC_50: 0x44, SOC_30: 0x45, SOC_10: 0x46, SOC_100: 0x47,
  VCAL_BASE: 0xb0,        // 0xB0…0xCF — калибровка напряжений ячеек
  TCAL_BASE: 0xd0,        // 0xD0…0xD7 — калибровка датчиков температуры
  // ---------- управление (запись) ----------
  CTRL_BALANCE: 0xe2,     // разрешить/запретить балансировку
  CTRL_RESET: 0xe3,       // сброс платы (осторожно!)
  CTRL_SOC_RESET: 0x0a,   // принудительный пересчёт SOC
  CAL_CURRENT: 0xad,      // 0xAD — ток 0 А, 0xAE — ток заряда, 0xAF — ток разряда
  // ---------- пороги защит (основной набор) ----------
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

/** Основные настройки (защиты, ёмкость, балансировка) — масштаб сверен с bms-tools. */
const CORE_SETTINGS = [
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

/** Биты регистра 0x2D «функции платы» (порядок — как в jbdtool). */
export const FUNC_BITS = [
  { mask: 0x01, key: 'switch', label: 'Ключ/выключатель' },
  { mask: 0x02, key: 'scrl', label: 'Сон / пересчёт тока' },
  { mask: 0x04, key: 'balance', label: 'Балансировка разрешена' },
  { mask: 0x08, key: 'chg_balance', label: 'Балансировка только на заряде' },
  { mask: 0x10, key: 'led', label: 'Светодиодная индикация' },
  { mask: 0x20, key: 'led_num', label: 'Диоды показывают число ячеек' },
  { mask: 0x40, key: 'rtc', label: 'Часы реального времени' },
  { mask: 0x80, key: 'edv', label: 'Конечное напряжение разряда' },
];

/** Биты регистра 0x2E «датчики температуры». */
export const NTC_BITS = Array.from({ length: 8 }, (_, i) => ({ mask: 1 << i, key: `ntc${i + 1}`, label: `Датчик ${i + 1}` }));

/** Биты состояния ключей (регистр 0x03, байт FET). */
export const FET_BITS = [
  { mask: 0x01, key: 'chg', label: 'Ключ заряда включён' },
  { mask: 0x02, key: 'dchg', label: 'Ключ разряда включён' },
];

const socRow = (pct, reg, key) => ({
  reg, key, label: `Напряжение ячейки для ${pct} %`, unit: 'мВ', kind: 'mv', scale: 1, group: 'Таблица SOC',
});

/**
 * Дополнительные регистры EEPROM: таблица SOC, задержки срабатываний, индикация, счётчики.
 * Единицы взяты из открытого протокола JBD (SP04S034/SP21S001, jbdtool). Для плат других
 * вендоров часть регистров может не читаться — тогда поле показывается прочерком.
 */
const EXTRA_SETTINGS = [
  { reg: REG.CYCLE_CAP, key: 'cycle_cap', label: 'Ёмкость цикла', unit: 'мАч', kind: 'mah', scale: 10, group: 'Ёмкость и счётчики' },
  { reg: REG.LIFE_CAP, key: 'life_cap', label: 'Ёмкость за срок службы', unit: 'Ач', kind: 'mah', scale: 1000, group: 'Ёмкость и счётчики' },
  { reg: REG.CYCLE_CNT, key: 'cycle_cnt_ee', label: 'Число циклов (EEPROM)', unit: 'шт', kind: 'count', scale: 1, group: 'Ёмкость и счётчики' },
  { reg: REG.SOC_FULL, key: 'soc_full', label: 'Напряжение полного заряда (SOC1)', unit: 'мВ', kind: 'mv', scale: 1, group: 'Таблица SOC' },
  socRow(100, REG.SOC_100, 'soc_100'),
  socRow(90, REG.SOC_90, 'soc_90'),
  socRow(80, REG.SOC_80, 'soc_80'),
  socRow(70, REG.SOC_70, 'soc_70'),
  socRow(60, REG.SOC_60, 'soc_60'),
  socRow(50, REG.SOC_50, 'soc_50'),
  socRow(40, REG.SOC_40, 'soc_40'),
  socRow(30, REG.SOC_30, 'soc_30'),
  socRow(20, REG.SOC_20, 'soc_20'),
  socRow(10, REG.SOC_10, 'soc_10'),
  { reg: REG.SOC_EMPTY, key: 'soc_empty', label: 'Напряжение пустой батареи (SOC0)', unit: 'мВ', kind: 'mv', scale: 1, group: 'Таблица SOC' },
  { reg: REG.SMALL_CUR, key: 'small_cur', label: 'Ток малого заряда (порог «нет тока»)', unit: 'мА', kind: 'ma', scale: 1, group: 'Токи' },
  { reg: REG.HW_COVP, key: 'hw_covp', label: 'Аппаратное перенапряжение ячейки', unit: 'мВ', kind: 'mv', scale: 1, group: 'Аппаратные защиты' },
  { reg: REG.HW_CUVP, key: 'hw_cuvp', label: 'Аппаратное понижение ячейки', unit: 'мВ', kind: 'mv', scale: 1, group: 'Аппаратные защиты' },
  { reg: REG.FET_OFF_TIME, key: 'fet_off_time', label: 'Время выключения ключей после защиты', unit: 'с', kind: 'count', scale: 1, group: 'Задержки и индикация' },
  { reg: REG.LED_TIME, key: 'led_time', label: 'Время свечения индикатора', unit: 'с', kind: 'count', scale: 1, group: 'Задержки и индикация' },
  { reg: REG.CHG_DELAY, key: 'chg_ut_delay', label: 'Защита от переохлаждения на заряде — возврат', unit: 'с', kind: 'count', scale: 1, byte: 'lo', group: 'Задержки и индикация' },
  { reg: REG.CHG_DELAY, key: 'chg_ot_delay', label: 'Защита от перегрева на заряде — задержка', unit: 'с', kind: 'count', scale: 1, byte: 'hi', group: 'Задержки и индикация' },
  { reg: REG.DSG_DELAY, key: 'dsg_ut_delay', label: 'Переохлаждение на разряде — возврат', unit: 'с', kind: 'count', scale: 1, byte: 'lo', group: 'Задержки и индикация' },
  { reg: REG.DSG_DELAY, key: 'dsg_ot_delay', label: 'Перегрев на разряде — задержка', unit: 'с', kind: 'count', scale: 1, byte: 'hi', group: 'Задержки и индикация' },
  { reg: REG.PACK_DELAY, key: 'pack_uv_delay', label: 'Понижение напряжения батареи — возврат', unit: 'с', kind: 'count', scale: 1, byte: 'lo', group: 'Задержки и индикация' },
  { reg: REG.PACK_DELAY, key: 'pack_ov_delay', label: 'Перенапряжение батареи — задержка', unit: 'с', kind: 'count', scale: 1, byte: 'hi', group: 'Задержки и индикация' },
  { reg: REG.CELL_DELAY, key: 'cell_uv_delay', label: 'Понижение ячейки — возврат', unit: 'с', kind: 'count', scale: 1, byte: 'lo', group: 'Задержки и индикация' },
  { reg: REG.CELL_DELAY, key: 'cell_ov_delay', label: 'Перенапряжение ячейки — задержка', unit: 'с', kind: 'count', scale: 1, byte: 'hi', group: 'Задержки и индикация' },
  { reg: REG.CHG_OC_DELAY, key: 'chg_oc_delay', label: 'Перегрузка по заряду — задержка', unit: 'с', kind: 'count', scale: 1, byte: 'hi', group: 'Задержки и индикация' },
  { reg: REG.CHG_OC_DELAY, key: 'chg_oc_rel', label: 'Перегрузка по заряду — возврат', unit: 'с', kind: 'count', scale: 1, byte: 'lo', group: 'Задержки и индикация' },
  { reg: REG.DSG_OC_DELAY, key: 'dsg_oc_delay', label: 'Перегрузка по разряду — задержка', unit: 'с', kind: 'count', scale: 1, byte: 'hi', group: 'Задержки и индикация' },
  { reg: REG.DSG_OC_DELAY, key: 'dsg_oc_rel', label: 'Перегрузка по разряду — возврат', unit: 'с', kind: 'count', scale: 1, byte: 'lo', group: 'Задержки и индикация' },
  { reg: REG.FUNC_MASK, key: 'func_mask', label: 'Функции платы', unit: '', kind: 'mask', scale: 1, bits: FUNC_BITS, group: 'Маски' },
  { reg: REG.NTC_MASK, key: 'ntc_mask', label: 'Датчики температуры', unit: '', kind: 'mask', scale: 1, bits: NTC_BITS, group: 'Маски' },
  { reg: REG.CUR_SHUNT, key: 'cur_shunt', label: 'Сопротивление шунта', unit: 'мкОм', kind: 'count', scale: 1, group: 'Калибровка (только чтение)' },
  { reg: REG.MFG_DATE_EE, key: 'mfg_date_ee', label: 'Дата производства (EEPROM)', unit: '', kind: 'datebits', scale: 1, group: 'Паспорт' },
  { reg: REG.SERIAL_EE, key: 'serial_ee', label: 'Серийный номер (EEPROM)', unit: '', kind: 'hex', scale: 1, group: 'Паспорт' },
];

/** Полный список настроек: основные + дополнительные регистры EEPROM. */
export const SETTINGS = [...CORE_SETTINGS, ...EXTRA_SETTINGS];


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
  if (def.byte) return def.byte === 'hi' ? (raw >> 8) & 0xff : raw & 0xff;
  switch (def.kind) {
    case 'temp': return decodeTemp(raw);
    case 'datebits': { const d = decodeDate(raw); return `${String(d.day).padStart(2, '0')}.${String(d.month).padStart(2, '0')}.${d.year}`; }
    case 'hex': return `0x${raw.toString(16).toUpperCase().padStart(4, '0')}`;
    case 'count':
    case 'mask': return raw;
    default: return raw * (def.scale ?? 1);
  }
}

/** Разложить регистр с побитовыми полями на список { bit, mask, label, on }. */
export function splitBits(mask, bits) {
  const m = Number(mask) || 0;
  return (bits ?? []).map((b) => ({ mask: b.mask, key: b.key, label: b.label, on: Boolean(m & b.mask) }));
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
  // ---- дополнительные регистры (таблица SOC, задержки, маски) ----
  cycle_cap: { group: 'Ёмкость и счётчики', min: 1000, max: 500000, step: 10 },
  soc_full: { group: 'Таблица SOC', min: 1500, max: 4300, step: 1 },
  soc_empty: { group: 'Таблица SOC', min: 1500, max: 4300, step: 1, risky: true },
  soc_100: { group: 'Таблица SOC', min: 1500, max: 4300, step: 1 },
  soc_90: { group: 'Таблица SOC', min: 1500, max: 4300, step: 1 },
  soc_80: { group: 'Таблица SOC', min: 1500, max: 4300, step: 1 },
  soc_70: { group: 'Таблица SOC', min: 1500, max: 4300, step: 1 },
  soc_60: { group: 'Таблица SOC', min: 1500, max: 4300, step: 1 },
  soc_50: { group: 'Таблица SOC', min: 1500, max: 4300, step: 1 },
  soc_40: { group: 'Таблица SOC', min: 1500, max: 4300, step: 1 },
  soc_30: { group: 'Таблица SOC', min: 1500, max: 4300, step: 1 },
  soc_20: { group: 'Таблица SOC', min: 1500, max: 4300, step: 1 },
  soc_10: { group: 'Таблица SOC', min: 1500, max: 4300, step: 1 },
  small_cur: { group: 'Токи', min: 0, max: 10000, step: 1 },
  hw_covp: { group: 'Аппаратные защиты', min: 2500, max: 4500, step: 1, risky: true },
  hw_cuvp: { group: 'Аппаратные защиты', min: 1500, max: 3800, step: 1, risky: true },
  fet_off_time: { group: 'Задержки и индикация', min: 0, max: 65535, step: 1 },
  led_time: { group: 'Задержки и индикация', min: 0, max: 65535, step: 1 },
  chg_ut_delay: { group: 'Задержки и индикация', min: 0, max: 255, step: 1 },
  chg_ot_delay: { group: 'Задержки и индикация', min: 0, max: 255, step: 1 },
  dsg_ut_delay: { group: 'Задержки и индикация', min: 0, max: 255, step: 1 },
  dsg_ot_delay: { group: 'Задержки и индикация', min: 0, max: 255, step: 1 },
  pack_uv_delay: { group: 'Задержки и индикация', min: 0, max: 255, step: 1 },
  pack_ov_delay: { group: 'Задержки и индикация', min: 0, max: 255, step: 1 },
  cell_uv_delay: { group: 'Задержки и индикация', min: 0, max: 255, step: 1 },
  cell_ov_delay: { group: 'Задержки и индикация', min: 0, max: 255, step: 1 },
  chg_oc_delay: { group: 'Задержки и индикация', min: 0, max: 255, step: 1 },
  chg_oc_rel: { group: 'Задержки и индикация', min: 0, max: 255, step: 1 },
  dsg_oc_delay: { group: 'Задержки и индикация', min: 0, max: 255, step: 1 },
  dsg_oc_rel: { group: 'Задержки и индикация', min: 0, max: 255, step: 1 },
  func_mask: { group: 'Маски', min: 0, max: 65535, step: 1, risky: true },
  ntc_mask: { group: 'Маски', min: 0, max: 65535, step: 1, risky: true },
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
  // таблица SOC: напряжения должны убывать от полного заряда к пустой батарее
  ['soc_full', '>', 'soc_100', 'напряжение полного заряда должно быть выше напряжения 100 %'],
  ['soc_100', '>', 'soc_90', 'напряжение 100 % должно быть выше 90 %'],
  ['soc_90', '>', 'soc_80', 'напряжение 90 % должно быть выше 80 %'],
  ['soc_80', '>', 'soc_70', 'напряжение 80 % должно быть выше 70 %'],
  ['soc_70', '>', 'soc_60', 'напряжение 70 % должно быть выше 60 %'],
  ['soc_60', '>', 'soc_50', 'напряжение 60 % должно быть выше 50 %'],
  ['soc_50', '>', 'soc_40', 'напряжение 50 % должно быть выше 40 %'],
  ['soc_40', '>', 'soc_30', 'напряжение 40 % должно быть выше 30 %'],
  ['soc_30', '>', 'soc_20', 'напряжение 30 % должно быть выше 20 %'],
  ['soc_20', '>', 'soc_10', 'напряжение 20 % должно быть выше 10 %'],
  ['soc_10', '>', 'soc_empty', 'напряжение 10 % должно быть выше напряжения пустой батареи'],
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

/**
 * Значение интерфейса → сырое 16-битное значение регистра с учётом байтовых полей.
 * currentRaw — текущее содержимое регистра (нужно, если параметр занимает один байт).
 */
export function encodeSetting(def, value, currentRaw = null) {
  const one = settingToRaw(def, value);
  if (!def.byte) return one;
  if (currentRaw === null || currentRaw === undefined) {
    throw new BmsProtocolError(`${def.label}: не прочитан текущий регистр 0x${def.reg.toString(16)} — запись байтового поля невозможна`);
  }
  const base = Number(currentRaw) & 0xffff;
  return def.byte === 'hi' ? ((one & 0xff) << 8) | (base & 0x00ff) : (base & 0xff00) | (one & 0xff);
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

// ---------- управление (заводской режим, без сохранения в память платы) ----------

/** Регистры управления: ключи заряда/разряда и остаток ёмкости (как в bms-tools). */
export const CTRL_REG = { CAP_REM: 0xe0, CHG_DSG_EN: 0xe1 };

/** Ключи → значение регистра 0xE1: бит 0 = заряд выключен, бит 1 = разряд выключен. */
export function fetRaw({ charge, discharge }) {
  return (charge ? 0 : 1) | (discharge ? 0 : 2);
}

/** Остаток ёмкости, Ач → регистр 0xE0 (единица — 10 мАч). */
export function capRemRaw(ah) {
  const raw = Math.round(Number(ah) * 100);
  if (!Number.isFinite(Number(ah)) || raw < 0 || raw > 0xffff) throw new BmsProtocolError('остаток ёмкости вне диапазона регистра');
  return raw;
}

// ---------- сведения о плате (что ещё можно прочитать) ----------
//
// Ответ на короткий регистр приходит переменной длины: строки, дата,serial.
// Здесь описаны все регистры, которые приложение читает автоматически.
// Неизвестный/неподдерживаемый регистр не ошибка: поле показывается прочерком.

/** ASCII-строка без нулей и пробелов по краям. */
export function parseText(data) {
  return data.toString('utf8').replace(/\0+/g, ' ').trim();
}

/** Байты как hex-строка (серийный номер, паспорт). */
export function parseHexBytes(data) {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/** Дата производства отдельным регистром: байт 0 — год−2000, 1 — месяц, 2 — день. */
export function parseDateBytes(data) {
  if (data.length < 3) return null;
  return { year: 2000 + data[0], month: data[1], day: data[2] };
}

/**
 * Регистры сведений о плате. kind: 'text' | 'hex' | 'date' | 'u16' | 'mask'.
 * scale для 'u16' — множитель сырого значения.
 */
export const INFO_REGS = [
  { key: 'device_name', reg: REG.DEVICE_NAME, label: 'Имя устройства', kind: 'text', group: 'Паспорт' },
  { key: 'hw_version', reg: REG.HW_VERSION, label: 'Версия аппаратной части', kind: 'text', group: 'Паспорт' },
  { key: 'sw_version', reg: REG.SW_VERSION, label: 'Версия прошивки', kind: 'text', group: 'Паспорт' },
  { key: 'prod_date', reg: REG.PROD_DATE, label: 'Дата производства', kind: 'date', group: 'Паспорт' },
  { key: 'serial', reg: REG.SERIAL, label: 'Серийный номер', kind: 'hex', group: 'Паспорт' },
  { key: 'life_cap', reg: REG.LIFE_CAP, label: 'Ёмкость за срок службы', kind: 'u16', scale: 1000, unit: 'мАч', group: 'Износ' },
  { key: 'mfg_name', reg: REG.MFG_NAME, label: 'Изготовитель', kind: 'text', group: 'Паспорт' },
  { key: 'model_name', reg: REG.MODEL_NAME, label: 'Модель платы', kind: 'text', group: 'Паспорт' },
  { key: 'barcode', reg: REG.BARCODE, label: 'Штрихкод / паспорт', kind: 'text', group: 'Паспорт' },
];

/** Разбор одного регистра сведений. */
export function decodeInfo(def, data) {
  if (!data || !data.length) return null;
  switch (def.kind) {
    case 'text': return parseText(data) || null;
    case 'hex': return parseHexBytes(data);
    case 'date': {
      const d = parseDateBytes(data);
      if (!d) return null;
      return `${String(d.day).padStart(2, '0')}.${String(d.month).padStart(2, '0')}.${d.year}`;
    }
    case 'u16': return data.length >= 2 ? data.readUInt16BE(0) * (def.scale ?? 1) : null;
    case 'mask': return data.length >= 2 ? data.readUInt16BE(0) : null;
    default: return null;
  }
}

// ---------- каталог регистров для консоли ----------
//
// Полный список того, что плата вообще понимает: чтение, запись, управление.
// access: 'r' — читается, 'w' — только запись, 'rw' — и то и другое.

export const REG_CATALOG = [
  ...[{ reg: 0x00, label: 'Состояние и защиты (биты)', access: 'rw', note: 'запись 56 78 — вход в заводской режим', group: 'Служебные' },
    { reg: 0x01, label: 'Выход из заводского режима', access: 'w', note: '28 28 — сохранить, 00 00 — без сохранения', group: 'Служебные' },
    { reg: 0x02, label: 'Тип батареи / число ячеек', access: 'r', group: 'Служебные' },
    { reg: 0x03, label: 'Базовая информация о батарее', access: 'r', group: 'Данные' },
    { reg: 0x04, label: 'Напряжения ячеек', access: 'r', group: 'Данные' },
    { reg: 0x05, label: 'Имя устройства', access: 'r', group: 'Паспорт' },
    { reg: 0x06, label: 'Пароль (запись) / версия аппаратной части (чтение)', access: 'rw', group: 'Служебные' },
    { reg: 0x07, label: 'Версия прошивки', access: 'r', group: 'Паспорт' },
    { reg: 0x08, label: 'Дата производства', access: 'r', group: 'Паспорт' },
    { reg: 0x09, label: 'Серийный номер', access: 'r', group: 'Паспорт' },
    { reg: 0x0a, label: 'Ёмкость за срок службы / сброс SOC (запись 18 81)', access: 'rw', risky: true, group: 'Служебные' },
    { reg: 0xaa, label: 'Счётчики срабатываний защит', access: 'r', group: 'Данные' },
    { reg: 0xa0, label: 'Изготовитель', access: 'r', group: 'Паспорт' },
    { reg: 0xa1, label: 'Модель устройства', access: 'r', group: 'Паспорт' },
    { reg: 0xa2, label: 'Штрихкод', access: 'r', group: 'Паспорт' },
    { reg: 0xad, label: 'Калибровка: ток 0 А', access: 'rw', risky: true, group: 'Калибровка' },
    { reg: 0xae, label: 'Калибровка: ток заряда', access: 'rw', risky: true, group: 'Калибровка' },
    { reg: 0xaf, label: 'Калибровка: ток разряда', access: 'rw', risky: true, group: 'Калибровка' },
    { reg: 0xe0, label: 'Остаток ёмкости (единица 10 мАч)', access: 'w', group: 'Управление' },
    { reg: 0xe1, label: 'Ключи заряда и разряда (бит = выключено)', access: 'rw', group: 'Управление' },
    { reg: 0xe2, label: 'Балансировка: 00 EE — вкл., 00 00 — выкл.', access: 'w', group: 'Управление' },
    { reg: 0xe3, label: 'Мягкая перезагрузка платы (запись 43 21)', access: 'w', risky: true, group: 'Управление' },
  ],
  ...SETTINGS.map((d) => ({
    reg: d.reg,
    label: `${d.label}${d.byte ? ` (${d.byte === 'hi' ? 'старший байт' : 'младший байт'})` : ''}`,
    access: WRITE_LIMITS[d.key] ? 'rw' : 'r',
    group: d.group ?? WRITE_LIMITS[d.key]?.group ?? 'Настройки',
  })),
  // калибровка напряжений ячеек (0xB0…0xCF) и датчиков (0xD0…0xD7)
  ...Array.from({ length: 32 }, (_, i) => ({
    reg: REG.VCAL_BASE + i, label: `Поправка напряжения ячейки ${i + 1}`, access: 'rw', risky: true, group: 'Калибровка',
  })),
  ...Array.from({ length: 8 }, (_, i) => ({
    reg: REG.TCAL_BASE + i, label: `Поправка датчика температуры ${i + 1}`, access: 'rw', risky: true, group: 'Калибровка',
  })),
].filter((item, i, arr) => arr.findIndex((x) => x.reg === item.reg && x.group === item.group) === i)
  .sort((a, b) => a.reg - b.reg);

/** Что можно менять командами управления (не регистрами EEPROM). */
export const CONTROL_CMDS = [
  {
    key: 'fet', reg: CTRL_REG.CHG_DSG_EN, label: 'Ключи заряда и разряда', save: false, verified: true,
    note: 'бит 0 — выключить заряд, бит 1 — выключить разряд',
  },
  {
    key: 'cap_rem', reg: CTRL_REG.CAP_REM, label: 'Остаток ёмкости (SOC)', save: false, verified: true,
    note: 'единица регистра — 10 мАч',
  },
  {
    key: 'balance', reg: REG.CTRL_BALANCE, label: 'Балансировка', save: false, verified: false, risky: true,
    note: '0x00EE — разрешить, 0x0000 — запретить (по открытому протоколу, проверьте на своей плате)',
  },
  {
    key: 'clear_errors', reg: null, label: 'Сброс счётчиков защит', save: true, verified: true,
    note: 'вход и выход из заводского режима с сохранением',
  },
  {
    key: 'soc_reset', reg: REG.CTRL_SOC_RESET, label: 'Принудительный пересчёт SOC', save: true, verified: false, risky: true,
    note: 'запись 0x1881: плата заново считает остаток ёмкости',
  },
  {
    key: 'soft_reset', reg: REG.CTRL_RESET, label: 'Перезагрузка платы', save: false, verified: false, risky: true,
    note: 'запись 0x4321: команда перезапуска — разрыв связи на несколько секунд',
  },
];
