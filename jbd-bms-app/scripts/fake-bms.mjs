// Эмулятор BMS JBD: отвечает на кадры протокола так же, как плата.
// Нужен для тестов и для демо-режима приложения (без платы). Значения —
// типичные для LiFePO4-батареи 4S 12 В. Записи принимаются, но состояние
// эмулятора не меняют.

import { buildFrameForResponse, REG, SETTINGS } from './jbd-protocol.mjs';

/** Простой «эмулятор» одного устройства: байты запроса → байты ответа. */
export class FakeBmsDevice {
  constructor({ cellCount = 4, name = 'DEMO JBD 4S 12V', tick = 0 } = {}) {
    this.cellCount = cellCount;
    this.name = name;
    this.tick = tick;
    this.rx = Buffer.alloc(0);
    this.errorCounts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  }

  /** Состояние батареи на текущем «кадре симуляции». */
  state() {
    const t = this.tick;
    const cells = [];
    for (let i = 0; i < this.cellCount; i++) {
      cells.push(3310 + Math.round(12 * Math.sin((t / 7) + i)) + (i === 2 ? 4 : 0));
    }
    const sum = cells.reduce((a, b) => a + b, 0);
    const currentMa = Math.round(-2400 + 2000 * Math.sin(t / 5)); // минус — разряд
    return {
      cells,
      packMv: sum,
      currentMa,
      remainingMah: 62000 + Math.round(200 * Math.sin(t / 30)),
      fullMah: 100000,
      cycles: 127,
      temps: [25.4, 26.1],
      chargeOn: true,
      dischargeOn: true,
      balance: t % 9 < 3 ? [3] : [],
      capPct: 62,
      faults: 0,
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

  #answer(op, reg, data) {
    if (op === 0x5a) return buildFrameForResponse(reg, 0x00, Buffer.alloc(0)); // запись: принимаем
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
      default: {
        const def = SETTINGS.find((d) => d.reg === reg);
        if (def) return buildFrameForResponse(reg, 0x00, this.#settingPayload(def));
        return buildFrameForResponse(reg, 0x80, Buffer.alloc(0)); // неизвестный регистр
      }
    }
  }

  #basicPayload(s) {
    const b = Buffer.alloc(23 + 2 * 2);
    b.writeUInt16BE(Math.round(s.packMv / 10), 0);                     // напряжение, 10 мВ
    b.writeInt16BE(Math.round(s.currentMa / 10), 2);                   // ток, 10 мА (знаковый)
    b.writeUInt16BE(Math.round(s.remainingMah / 10), 4);               // остаток, 10 мАч
    b.writeUInt16BE(Math.round(s.fullMah / 10), 6);                    // полная ёмкость, 10 мАч
    b.writeUInt16BE(s.cycles, 8);
    // дата 2024-05-17: год−2000 в битах 9–15, месяц 5–8, день 0–4
    b.writeUInt16BE(((2024 - 2000) << 9) | (5 << 5) | 17, 10);
    const bal = s.balance.reduce((m, cell) => m | (1 << (cell - 1)), 0);
    b.writeUInt16BE(bal & 0xffff, 12);
    b.writeUInt16BE((bal >>> 16) & 0xffff, 14);
    b.writeUInt16BE(s.faults, 16);
    b[18] = 0x10;                                   // версия прошивки (условно)
    b[19] = s.capPct;
    b[20] = (s.chargeOn ? 1 : 0) | (s.dischargeOn ? 2 : 0);
    b[21] = s.cells.length;
    b[22] = s.temps.length;
    s.temps.forEach((t, i) => b.writeUInt16BE(Math.round(t * 10 + 2731), 23 + i * 2));
    return b.subarray(0, 23 + s.temps.length * 2);
  }

  #settingPayload(def) {
    // значения, типичные для JBD (сырые величины, как в EEPROM)
    const defaults = {
      covp: 3650, covp_rel: 3350, cuvp: 2500, cuvp_rel: 2900,
      povp: 1460, povp_rel: 1340, puvp: 1000, puvp_rel: 1120,
      chgoc: 600, dsgoc: 1000,
      chgot: 45, chgot_rel: 40, chgut: 0, chgut_rel: 5, dsgot: 60, dsgot_rel: 55, dsgut: -20, dsgut_rel: -15,
      bal_start: 3400, bal_window: 10, design_cap: 10000, cell_cnt: this.cellCount,
    };
    const v = defaults[def.key];
    const b = Buffer.alloc(2);
    if (def.kind === 'temp') b.writeUInt16BE(Math.round(v * 10 + 2731), 0);
    else if (def.scale === 10) b.writeUInt16BE(Math.round(v / 10), 0);
    else b.writeUInt16BE(Math.round(v / (def.scale ?? 1)), 0);
    return b;
  }
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

