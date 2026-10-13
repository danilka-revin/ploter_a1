// Эмулятор BMS JBD: отвечает на кадры протокола так же, как плата.
// Нужен для тестов и для демо-режима приложения (без платы). Значения —
// типичные для LiFePO4-сборки 12S. Запись настроек принимается только в
// заводском режиме (как у платы) и сохраняется в EEPROM-модель.
//
// Профиль (`profile`) задаёт «характер» батареи, чтобы банки в демо отличались:
// направление тока, ёмкость, число ячеек, температура.

import { buildFrameForResponse, REG, SETTINGS, settingToRaw, encodeSetting, CTRL_REG } from './jbd-protocol.mjs';

/** Значения EEPROM по умолчанию, в единицах интерфейса (мВ, мА, мАч, °C, с). */
export const DEMO_SETTINGS = {
  covp: 3650, covp_rel: 3350, cuvp: 2500, cuvp_rel: 2900,
  povp: 43800, povp_rel: 40200, puvp: 30000, puvp_rel: 33600,
  chgoc: 40000, dsgoc: 80000,
  chgot: 45, chgot_rel: 40, chgut: 0, chgut_rel: 5, dsgot: 60, dsgot_rel: 55, dsgut: -20, dsgut_rel: -15,
  bal_start: 3400, bal_window: 10, design_cap: 100000,
  // дополнительные регистры
  cycle_cap: 100000, life_cap: 4120000, cycle_cnt_ee: 127,
  soc_full: 3650, soc_100: 3560, soc_90: 3480, soc_80: 3440, soc_70: 3420, soc_60: 3400,
  soc_50: 3380, soc_40: 3360, soc_30: 3340, soc_20: 3320, soc_10: 3260, soc_empty: 2800,
  small_cur: 300, hw_covp: 3750, hw_cuvp: 2400,
  fet_off_time: 8, led_time: 3,
  chg_ut_delay: 2, chg_ot_delay: 2, dsg_ut_delay: 2, dsg_ot_delay: 2,
  pack_uv_delay: 4, pack_ov_delay: 4, cell_uv_delay: 3, cell_ov_delay: 3,
  chg_oc_delay: 8, chg_oc_rel: 3, dsg_oc_delay: 8, dsg_oc_rel: 3,
  func_mask: 0x0006, ntc_mask: 0x0003, cur_shunt: 2000,
};

/** Текстовые регистры паспорта. */
const DEMO_TEXT = {
  [REG.HW_VERSION]: 'HW 1.3',
  [REG.SW_VERSION]: 'SW 4.21-LFP',
  [REG.MFG_NAME]: 'Shenzhen Jiabaida',
  [REG.MODEL_NAME]: 'JBD-SP14S004',
  [REG.BARCODE]: 'JBD12S2024X0042',
};

/** Разные «характеры» для демо-банков: куда течёт ток и какой объём. */
const PROFILES = {
  discharge: { dir: -1, amp: 26, capPct: 62, remaining: 62000 },
  charge: { dir: 1, amp: 18, capPct: 88, remaining: 88000 },
  idle: { dir: 0, amp: 1.2, capPct: 47, remaining: 47000 },
  balancing: { dir: -1, amp: 8, capPct: 74, remaining: 74000 },
};

export class FakeBmsDevice {
  constructor({ cellCount = 12, name = 'DEMO JBD 12S', tick = 0, password = '', profile = 'discharge', seed = 0, faults = 0, temps = 2 } = {}) {
    this.cellCount = cellCount;
    this.name = name;
    this.tick = tick;
    this.seed = seed;
    this.profile = PROFILES[profile] ?? PROFILES.discharge;
    this.profileName = profile;
    this.rx = Buffer.alloc(0);
    this.errorCounts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    // пароль по умолчанию — шесть нулевых байт (как в bms-tools)
    this.password = password ? Buffer.from(password, 'ascii') : Buffer.alloc(6);
    this.factory = false;
    this.writesSaved = 0;
    this.fetCtrl = 0;            // регистр 0xE1: бит0 заряд выкл., бит1 разряд выкл.
    this.balanceOn = true;      // регистр 0xE2
    this.resetCommands = 0;     // сколько раз прислали опасную команду (0xE3 / 0x0A)
    this.remOverrideMah = null; // остаток ёмкости после ручной установки (0xE0)
    this.faults = faults;       // активные защиты (биты регистра состояния)
    this.ntcCount = temps;
    this.rawText = new Map();  // регистры, которые нельзя выразить числом (дата, hex)
    // EEPROM-модель: сырые 16-битные значения по регистрам
    this.eeprom = new Map();
    for (const def of SETTINGS) {
      const v = def.key === 'cell_cnt' ? cellCount : DEMO_SETTINGS[def.key];
      if (v === undefined) continue;
      if (typeof v === 'string') { this.rawText.set(def.reg, v); this.eeprom.set(def.reg, 0); continue; }
      // байтовое поле: новое содержимое регистра = старое значение с заменой одного байта
      const raw = def.byte ? encodeSetting(def, v, this.eeprom.get(def.reg) ?? 0) : settingToRaw(def, v);
      this.eeprom.set(def.reg, raw);
    }
  }

  /** Состояние батареи на текущем «кадре симуляции». */
  state() {
    const t = this.tick + this.seed * 13;
    const p = this.profile;
    const base = 3310 + Math.round(40 * Math.sin((t + this.seed * 90) / 900));
    const cells = [];
    for (let i = 0; i < this.cellCount; i++) {
      // ячейка №3 чуть отстаёт — наглядная балансировка и разброс
      const lag = i === 2 ? 9 + Math.round(4 * Math.sin(t / 40)) : 0;
      cells.push(base + Math.round(11 * Math.sin(t / 7 + i + this.seed)) - lag);
    }
    const sum = cells.reduce((a, b) => a + b, 0);
    const wobble = 1 + 0.35 * Math.sin(t / 11);
    const currentMa = Math.round((p.dir * p.amp * 1000 * wobble) / 10) * 10;
    const drift = Math.round(t * p.dir * 4);
    const remaining = Math.max(1000, Math.min(p.remaining + drift, 99000));
    const warm = p.dir === 0 ? 0 : 2.5 * Math.abs(Math.sin(t / 25));
    return {
      cells,
      packMv: sum,
      currentMa,
      remainingMah: this.remOverrideMah ?? remaining,
      fullMah: 100000,
      cycles: 127,
      temps: Array.from({ length: this.ntcCount }, (_, i) => 25 + warm + i * 0.7 + Math.sin((t + i * 30) / 60) * 1.2),
      chargeOn: !(this.fetCtrl & 1),
      dischargeOn: !(this.fetCtrl & 2),
      balance: this.balanceOn && t % 9 < 3 ? [3] : [],
      capPct: p.capPct,
      faults: this.faults,
    };
  }

  /** Ответ на байты, пришедшие от хоста. Возвращает Buffer с ответами (может быть пустым). */
  receive(bytes) {
    this.rx = Buffer.concat([this.rx, Buffer.from(bytes)]);
    const out = [];
    // запросы имеют форму DD op reg len data cs 77 — разбираем тем же алгоритмом длины
    let i = 0;
    while (i < this.rx.length) {
      if (this.rx[i] !== 0xdd) { i++; continue; }
      if (this.rx.length - i < 7) break;
      const len = this.rx[i + 3];
      const total = len + 7;
      if (this.rx.length - i < total) break;
      const frame = this.rx.subarray(i, i + total);
      i += total;
      if (frame[total - 1] !== 0x77) continue;
      const op = frame[1];
      const reg = frame[2];
      const data = frame.subarray(4, 4 + len);
      out.push(this.#answer(op, reg, data));
    }
    this.rx = this.rx.subarray(i);
    this.tick++;
    return out.length ? Buffer.concat(out) : Buffer.alloc(0);
  }

  #u16(reg, value) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(value & 0xffff, 0);
    return buildFrameForResponse(reg, 0x00, b);
  }

  #answer(op, reg, data) {
    if (op === 0x5a) return this.#write(reg, data);
    if (op !== 0xa5) return Buffer.alloc(0);
    const s = this.state();
    switch (reg) {
      case REG.BASIC_INFO: return buildFrameForResponse(reg, 0x00, this.#basicPayload(s));
      case REG.CELL_INFO: {
        const b = Buffer.alloc(s.cells.length * 2);
        s.cells.forEach((v, i) => b.writeUInt16BE(v, i * 2));
        return buildFrameForResponse(reg, 0x00, b);
      }
      case REG.DEVICE_NAME: return buildFrameForResponse(reg, 0x00, Buffer.from(this.name, 'utf8'));
      case REG.ERROR_COUNTS: {
        const b = Buffer.alloc(this.errorCounts.length * 2);
        this.errorCounts.forEach((v, i) => b.writeUInt16BE(v, i * 2));
        return buildFrameForResponse(reg, 0x00, b);
      }
      case REG.STATUS: return this.#u16(reg, s.faults);
      case REG.STRINGS: return this.#u16(reg, s.cells.length);
      case REG.PROD_DATE: return buildFrameForResponse(reg, 0x00, Buffer.from([24, 5, 17]));
      case REG.SERIAL: return buildFrameForResponse(reg, 0x00, Buffer.from([0x12, 0x34, 0x05, 0x00, 0x42]));
      case REG.LIFE_CAP: return this.#u16(reg, Math.round(DEMO_SETTINGS.life_cap / 1000));
      // дата и серийный номер в EEPROM — в «паспортных» форматах регистра
      case REG.MFG_DATE_EE: return this.#u16(reg, ((2024 - 2000) << 9) | (5 << 5) | 17);
      case REG.SERIAL_EE: return this.#u16(reg, 0x1234);
      case REG.HW_VERSION:
      case REG.SW_VERSION:
      case REG.MFG_NAME:
      case REG.MODEL_NAME:
      case REG.BARCODE:
        return buildFrameForResponse(reg, 0x00, Buffer.from(DEMO_TEXT[reg] ?? '', 'utf8'));
      default: {
        const def = SETTINGS.find((d) => d.reg === reg);
        if (def && this.eeprom.has(reg)) {
          if (this.rawText.has(reg)) return buildFrameForResponse(reg, 0x00, Buffer.from(this.rawText.get(reg), 'utf8'));
          return this.#u16(reg, this.eeprom.get(reg));
        }
        // калибровка ячеек (0xB0…0xCF) и датчиков (0xD0…0xD7) — у платы это тоже регистры
        if ((reg >= REG.VCAL_BASE && reg < REG.VCAL_BASE + 32) || (reg >= REG.TCAL_BASE && reg < REG.TCAL_BASE + 8)) {
          return this.#u16(reg, 0);
        }
        return buildFrameForResponse(reg, 0x80, Buffer.alloc(0)); // неизвестный регистр
      }
    }
  }

  /** Запись: пароль (0x06), вход/выход заводского режима (0x00/0x01), настройки — только в заводском режиме. */
  #write(reg, data) {
    if (reg === 0x06) {
      // данные: длина(1) + пароль(6)
      const ok = data.length === 7 && data[0] === 6 && data.subarray(1).equals(this.password);
      return ok ? buildFrameForResponse(reg, 0x00, Buffer.alloc(0)) : buildFrameForResponse(reg, 0x80, Buffer.alloc(0));
    }
    if (reg === 0x00) {
      if (data.length === 2 && data[0] === 0x56 && data[1] === 0x78) this.factory = true;
      return buildFrameForResponse(reg, 0x00, Buffer.alloc(0));
    }
    if (reg === 0x01) {
      if (this.factory && data.length === 2 && data[0] === 0x28 && data[1] === 0x28) {
        this.writesSaved++;
        this.errorCounts = this.errorCounts.map(() => 0);
      }
      this.factory = false;
      return buildFrameForResponse(reg, 0x00, Buffer.alloc(0));
    }
    if (reg === CTRL_REG.CHG_DSG_EN || reg === CTRL_REG.CAP_REM) {
      if (!this.factory || data.length !== 2) return buildFrameForResponse(reg, 0x80, Buffer.alloc(0));
      const raw = data.readUInt16BE(0);
      if (reg === CTRL_REG.CHG_DSG_EN) this.fetCtrl = raw & 0x03;
      else this.remOverrideMah = raw * 10;
      return buildFrameForResponse(reg, 0x00, Buffer.alloc(0));
    }
    if (reg === REG.CTRL_BALANCE) {
      if (!this.factory || data.length !== 2) return buildFrameForResponse(reg, 0x80, Buffer.alloc(0));
      this.balanceOn = data.readUInt16BE(0) === 0x00ee;
      return buildFrameForResponse(reg, 0x00, Buffer.alloc(0));
    }
    // опасные команды: плата перезапускается, эмулятор только считает обращения
    if (reg === REG.CTRL_RESET || reg === REG.CTRL_SOC_RESET) {
      this.resetCommands++;
      return buildFrameForResponse(reg, 0x00, Buffer.alloc(0));
    }
    const def = SETTINGS.find((d) => d.reg === reg);
    if (!def || !this.eeprom.has(reg) || !this.factory || data.length !== 2) {
      return buildFrameForResponse(reg, 0x80, Buffer.alloc(0));
    }
    this.eeprom.set(reg, data.readUInt16BE(0));
    return buildFrameForResponse(reg, 0x00, Buffer.alloc(0));
  }

  #basicPayload(s) {
    const b = Buffer.alloc(23 + s.temps.length * 2);
    b.writeUInt16BE(Math.round(s.packMv / 10), 0);                     // напряжение, 10 мВ
    b.writeInt16BE(Math.round(s.currentMa / 10), 2);                    // ток, 10 мА (знаковый)
    b.writeUInt16BE(Math.round(s.remainingMah / 10), 4);               // остаток, 10 мАч
    b.writeUInt16BE(Math.round(s.fullMah / 10), 6);                     // полная ёмкость, 10 мАч
    b.writeUInt16BE(s.cycles, 8);
    // дата 2024-05-17: год−2000 в битах 9–15, месяц 5–8, день 0–4
    b.writeUInt16BE(((2024 - 2000) << 9) | (5 << 5) | 17, 10);
    const bal = s.balance.reduce((m, cell) => m | (1 << (cell - 1)), 0);
    b.writeUInt16BE(bal & 0xffff, 12);
    b.writeUInt16BE((bal >>> 16) & 0xffff, 14);
    b.writeUInt16BE(s.faults, 16);
    b[18] = 0x10;                                   // версия прошивки (условно)
    b[19] = s.capPct;
    b[20] = (s.chargeOn ? 1 : 0) | (dischargeOnMask(s) ? 2 : 0);
    b[21] = s.cells.length;
    b[22] = s.temps.length;
    s.temps.forEach((t, i) => b.writeUInt16BE(Math.round(t * 10 + 2731), 23 + i * 2));
    return b;
  }
}

function dischargeOnMask(s) {
  return s.dischargeOn;
}

/** Транспорт в памяти: write() → эмулятор → onData(ответ) асинхронно (как UART). */
export function createFakeTransport(options = {}) {
  const device = new FakeBmsDevice(options);
  const listeners = [];
  let closed = false;
  return {
    device,
    async write(buf) {
      if (closed) throw new Error('порт закрыт');
      const reply = device.receive(buf);
      if (reply.length) {
        setTimeout(() => { for (const l of listeners) l(reply); }, options.latencyMs ?? 5);
      }
    },
    onData(cb) { listeners.push(cb); },
    async close() { closed = true; },
  };
}

/** Профили для демо «все банки»: четыре платы с разным поведением. */
export const DEMO_BANKS = [
  { name: 'JBD-12S-A', profile: 'discharge', cellCount: 12, temps: 3 },
  { name: 'JBD-16S-B', profile: 'charge', cellCount: 16, temps: 3 },
  { name: 'JBD-8S-C', profile: 'idle', cellCount: 8, temps: 2 },
  { name: 'JBD-12S-D', profile: 'balancing', cellCount: 12, temps: 4 },
];

/**
 * Несколько эмуляторов сразу — для демо «все банки» и для тестов панели.
 * @param {Array<object>} defs список профилей (по умолчанию — DEMO_BANKS)
 */
export function createFakeTransports(defs = DEMO_BANKS) {
  return defs.map((d, i) => createFakeTransport({ cellCount: d.cellCount ?? 12, name: d.name, profile: d.profile, seed: i }));
}
