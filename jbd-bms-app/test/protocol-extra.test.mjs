// Расширенная карта регистров JBD: таблица SOC, задержки, маски, паспорт платы,
// каталог для консоли и проверка значений перед записью.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS, WRITE_LIMITS, writableDefs, REG, REG_CATALOG, INFO_REGS, CONTROL_CMDS, FUNC_BITS, NTC_BITS,
  decodeSetting, encodeSetting, settingToRaw, checkSettingValue, checkSettingsConsistency, splitBits,
  decodeInfo, decodeTemp, parseText, parseHexBytes, parseDateBytes, passwordBytes, fetRaw, capRemRaw,
} from '../scripts/jbd-protocol.mjs';

const raw16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); return b; };
const def = (key) => SETTINGS.find((s) => s.key === key);

test('карта настроек полна и без повторов', () => {
  assert.equal(SETTINGS.length, 59, `описано регистров: ${SETTINGS.length}`);
  const keys = SETTINGS.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, 'ключи уникальны');
  for (const s of SETTINGS) {
    assert.ok(s.label && s.label.length > 3, `метка есть у всех: ${s.key}`);
    assert.ok(Number.isInteger(s.reg) && s.reg >= 0 && s.reg <= 0xff, `адрес регистра: ${s.key}`);
    assert.ok(['mv', 'ma', 'mah', 'temp', 'count', 'mask', 'datebits', 'hex'].includes(s.kind), `вид значения: ${s.key}`);
  }
  assert.ok(Object.keys(WRITE_LIMITS).length >= 50, 'записываемых параметров большинство');
  assert.equal(writableDefs().length, Object.keys(WRITE_LIMITS).length);
  for (const w of writableDefs()) {
    assert.ok(Number.isFinite(w.min) && Number.isFinite(w.max) && w.min < w.max, `пределы заданы: ${w.key}`);
    assert.ok(w.step > 0, `шаг задан: ${w.key}`);
  }
});

test('дополнительные регистры: таблица SOC, задержки, маски и паспорт', () => {
  const socKeys = ['soc_full', 'soc_100', 'soc_90', 'soc_80', 'soc_70', 'soc_60', 'soc_50', 'soc_40', 'soc_30', 'soc_20', 'soc_10', 'soc_empty'];
  assert.deepEqual(SETTINGS.map((s) => s.key).filter((k) => k.startsWith('soc_')), socKeys, 'строки SOC по убыванию');
  for (const k of ['chg_ot_delay', 'chg_oc_delay', 'cell_uv_delay', 'dsg_oc_rel']) {
    const d = def(k);
    assert.ok(d.byte === 'hi' || d.byte === 'lo', `${k} — байтовое поле`);
    assert.equal(d.reg >= 0x3a && d.reg <= 0x3f, true, `${k} лежит в 0x3A…0x3F`);
  }
  assert.equal(def('func_mask').bits, FUNC_BITS);
  assert.equal(def('ntc_mask').bits.length, NTC_BITS.length);
  assert.equal(def('cur_shunt').editable ?? true, true, 'шунт описан');
  assert.equal(def('life_cap').scale, 1000, 'ёмкость за срок службы — единица 1000 мАч');
});

test('разбор значений учитывает вид поля и байт', () => {
  assert.equal(decodeSetting(def('covp'), raw16(3650)), 3650);
  assert.equal(decodeSetting(def('povp'), raw16(5460)), 54600, 'напряжение батареи ×10');
  assert.equal(decodeSetting(def('chgoc'), raw16(1500)), 15000, 'ток ×10 мА');
  assert.equal(decodeSetting(def('design_cap'), raw16(10000)), 100000, 'ёмкость ×10 мАч');
  assert.equal(decodeSetting(def('chgot'), raw16(3181)), 45, 'температура: сырое значение = K×10');
  assert.equal(decodeTemp(2731), 0);
  assert.equal(decodeSetting(def('func_mask'), raw16(0x0006)), 6, 'маска — сырое число');
  assert.equal(decodeSetting(def('serial_ee'), raw16(0x1234)), '0x1234', 'серийный номер — hex');
  assert.equal(decodeSetting(def('mfg_date_ee'), raw16((24 << 9) | (5 << 5) | 17)), '17.05.2024');
  const reg = raw16((5 << 8) | 2);
  assert.equal(decodeSetting(def('chg_ot_delay'), reg), 5, 'старший байт — задержка');
  assert.equal(decodeSetting(def('chg_ut_delay'), reg), 2, 'младший байт — возврат');
});

test('подготовка к записи: байтовое поле не трогает соседний байт', () => {
  assert.equal(settingToRaw(def('chgot'), 45), 3181);
  assert.throws(() => settingToRaw(def('chgot'), 45.05), /шаг регистра/);
  assert.throws(() => settingToRaw(def('covp'), 70000), /не помещается/, 'регистр 16-битный');
  assert.equal(encodeSetting(def('covp'), 3600), 3600);
  assert.equal(encodeSetting(def('chg_ot_delay'), 9, 0x0502), 0x0902, 'младший байт сохранён');
  assert.equal(encodeSetting(def('chg_ut_delay'), 7, 0x0502), 0x0507, 'старший байт сохранён');
  assert.throws(() => encodeSetting(def('chg_ot_delay'), 9), /не прочитан текущий регистр/);
});

test('пределы и связность: платные значения не пройдут', () => {
  assert.equal(checkSettingValue('covp', 3600), null);
  assert.match(checkSettingValue('covp', 100), /допустимо от 2500 до 4250/);
  assert.match(checkSettingValue('cell_cnt', 16), /нельзя записать/, 'число ячеек не меняется');
  assert.match(checkSettingValue('nope', 1), /нельзя записать/);
  assert.match(checkSettingValue('covp', 'много'), /введите число/);
  const bad = checkSettingsConsistency({ covp: 3650, covp_rel: 3700, soc_90: 3300, soc_80: 3400 });
  assert.equal(bad.length, 2, bad.join(' | '));
  assert.match(bad[0], /перенапряжение ячейки должно быть выше возврата/);
  assert.match(bad[1], /90 % должно быть выше 80 %/);
  assert.deepEqual(checkSettingsConsistency({ covp: 3650 }), [], 'неполный набор не проверяется');
  assert.deepEqual(checkSettingsConsistency({
    covp: 3650, covp_rel: 3550, cuvp: 2700, cuvp_rel: 2800, povp: 58000, povp_rel: 56000,
    puvp: 42000, puvp_rel: 44000, chgot: 60, chgot_rel: 55, chgut: 0, chgut_rel: 5,
    dsgot: 65, dsgot_rel: 60, dsgut: -10, dsgut_rel: -5, bal_start: 3400, bal_window: 20,
    soc_full: 4200, soc_100: 4150, soc_90: 4100, soc_80: 4050, soc_70: 3900, soc_60: 3700,
    soc_50: 3380, soc_40: 3350, soc_30: 3330, soc_20: 3300, soc_10: 3200, soc_empty: 2800,
  }), [], 'корректный набор проходит');
});

test('маски раскладываются по битам', () => {
  const bits = splitBits(0x06, FUNC_BITS);
  assert.equal(bits.find((b) => b.key === 'balance').on, true);
  assert.equal(bits.find((b) => b.key === 'led').on, false);
  assert.equal(bits.length, FUNC_BITS.length);
  assert.equal(splitBits(0, FUNC_BITS).every((b) => !b.on), true);
  assert.equal(splitBits(undefined, NTC_BITS).every((b) => !b.on), true);
});

test('паспорт платы: строки, дата, serial и числовые поля', () => {
  assert.equal(INFO_REGS.length, 9);
  const byKey = (k) => INFO_REGS.find((i) => i.key === k);
  assert.equal(decodeInfo(byKey('hw_version'), Buffer.from('HW 1.3\0\0', 'ascii')), 'HW 1.3');
  assert.equal(decodeInfo(byKey('sw_version'), Buffer.from('SW 4.21-LFP', 'ascii')), 'SW 4.21-LFP');
  assert.equal(decodeInfo(byKey('prod_date'), Buffer.from([24, 5, 17])), '17.05.2024');
  assert.equal(decodeInfo(byKey('serial'), Buffer.from([0x12, 0x34, 0x05])), '12 34 05');
  assert.equal(decodeInfo(byKey('life_cap'), raw16(4120)), 4120000, 'единица регистра 1000 мАч');
  assert.equal(decodeInfo(byKey('barcode'), Buffer.alloc(0)), null, 'пустой ответ — прочерк, не падение');
  assert.equal(decodeInfo({ kind: 'нет-такого' }, Buffer.from([1, 2])), null);
  assert.equal(parseText(Buffer.from('JBD\0BMS\0\0', 'ascii')), 'JBD BMS', 'нули — разделители, хвост обрезается');
  assert.equal(parseHexBytes(Buffer.from([1, 255])), '01 FF');
  assert.deepEqual(parseDateBytes(Buffer.from([24, 12, 1])), { year: 2024, month: 12, day: 1 });
  assert.equal(parseDateBytes(Buffer.from([24])), null);
});

test('каталог регистров для консоли покрывает всё, что понимает плата', () => {
  assert.ok(REG_CATALOG.length > 100, `регистров в каталоге: ${REG_CATALOG.length}`);
  const regs = new Set(REG_CATALOG.map((r) => r.reg));
  for (const s of SETTINGS) assert.ok(regs.has(s.reg), `каталог знает про ${s.label}`);
  for (const n of [REG.BASIC_INFO, REG.CELL_INFO, REG.DEVICE_NAME, REG.ERROR_COUNTS, 0xe0, 0xe1, 0xe2, 0xe3, REG.VCAL_BASE, REG.TCAL_BASE]) {
    assert.ok(regs.has(n), `каталог знает регистр 0x${n.toString(16)}`);
  }
  for (const item of REG_CATALOG) {
    assert.ok(['r', 'w', 'rw'].includes(item.access), `доступ указан: 0x${item.reg.toString(16)}`);
    assert.ok(item.label && item.group, 'метка и группа есть у всех');
  }
  const calib = REG_CATALOG.filter((r) => r.group === 'Калибровка');
  assert.equal(calib.length, 32 + 8 + 3, 'поправки ячеек, датчиков и токов');
  assert.ok(calib.every((r) => r.risky), 'калибровка помечена как рискованная');
  const pairs = new Set(REG_CATALOG.map((r) => `${r.reg}:${r.group}`));
  assert.equal(pairs.size, REG_CATALOG.length, 'нет дублей');
  assert.deepEqual([...REG_CATALOG].sort((a, b) => a.reg - b.reg).map((r) => r.reg), REG_CATALOG.map((r) => r.reg), 'отсортирован по адресу');
});

test('команды управления описаны и помечены по надёжности', () => {
  assert.ok(CONTROL_CMDS.length >= 5);
  for (const c of CONTROL_CMDS) {
    assert.ok(c.key && c.label && c.note, `описание команды ${c.key}`);
    assert.equal(typeof c.verified, 'boolean', 'указано, проверена ли команда на реальном железе');
    if (!c.verified) assert.equal(c.risky, true, `${c.key}: непроверенное требует подтверждения риска`);
  }
});

test('пароль платы, ключи и остаток ёмкости', () => {
  assert.deepEqual([...passwordBytes('')], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...passwordBytes('abcdef')], [97, 98, 99, 100, 101, 102]);
  assert.throws(() => passwordBytes('abc'), /6 символов/);
  assert.throws(() => passwordBytes('ааббвв'), /6 символов/, 'только ASCII');
  assert.equal(fetRaw({ charge: true, discharge: true }), 0);
  assert.equal(fetRaw({ charge: false, discharge: true }), 1);
  assert.equal(fetRaw({ charge: true, discharge: false }), 2);
  assert.equal(fetRaw({ charge: false, discharge: false }), 3);
  assert.equal(capRemRaw(55.5), 5550);
  assert.throws(() => capRemRaw(700), /вне диапазона/);
  assert.throws(() => capRemRaw(-1), /вне диапазона/);
});
