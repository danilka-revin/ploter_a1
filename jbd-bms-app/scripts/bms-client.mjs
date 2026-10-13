// Клиент JBD-протокола поверх любого транспорта с интерфейсом:
//   transport.write(Buffer) → Promise
//   transport.onData(cb(Buffer))   — подписка на входящие байты
//   transport.close() → Promise
// Запросы выполняются строго по одному (очередь): BMS отвечает на один кадр
// за раз, и параллельные запросы перепутали бы ответы.

import {
  buildReadFrame, buildWriteFrame, extractResponses, BmsProtocolError,
  REG, parseBasicInfo, parseCellInfo, parseDeviceName, parseErrorCounters, decodeSetting,
} from './jbd-protocol.mjs';

export class BmsClient {
  /**
   * @param {object} transport
   * @param {{ timeoutMs?: number, retries?: number }} [opts]
   */
  constructor(transport, { timeoutMs = 800, retries = 1 } = {}) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.rx = Buffer.alloc(0);
    this.waiter = null; // { reg, resolve }
    this.queue = Promise.resolve();
    this.closed = false;
    transport.onData((chunk) => this.#onChunk(chunk));
  }

  #onChunk(chunk) {
    this.rx = Buffer.concat([this.rx, Buffer.from(chunk)]);
    const { frames, rest } = extractResponses(this.rx);
    this.rx = Buffer.from(rest);
    for (const f of frames) {
      if (this.waiter && f.reg === this.waiter.reg) {
        const w = this.waiter;
        this.waiter = null;
        w.resolve(f);
      }
    }
  }

  /** Все операции — через очередь. */
  #enqueue(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  #waitFrame(reg, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter && this.waiter.reg === reg) this.waiter = null;
        reject(new BmsProtocolError('BMS не ответил'));
      }, timeoutMs);
      this.waiter = {
        reg,
        resolve: (frame) => { clearTimeout(timer); resolve(frame); },
      };
    });
  }

  /**
   * Чтение регистра. Возвращает данные ответа (Buffer).
   * @throws BmsProtocolError при таймауте, ошибке статуса (0x80) или неверном ответе
   */
  read(reg, payload = []) {
    return this.#enqueue(async () => {
      if (this.closed) throw new BmsProtocolError('соединение закрыто');
      let lastErr = null;
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        this.rx = Buffer.alloc(0);
        const waiting = this.#waitFrame(reg, this.timeoutMs);
        await this.transport.write(buildReadFrame(reg, payload));
        try {
          const frame = await waiting;
          if (frame.status !== 0x00) {
            throw new BmsProtocolError(`BMS вернул статус 0x${frame.status.toString(16).padStart(2, '0')} для регистра 0x${reg.toString(16).padStart(2, '0')}`);
          }
          return frame.data;
        } catch (e) {
          if (e instanceof BmsProtocolError && e.message === 'BMS не ответил') { lastErr = e; continue; }
          throw e;
        }
      }
      throw lastErr;
    });
  }

  /**
   * Запись регистра. Используется только для явных действий пользователя.
   * Не вызывается приложением при чтении.
   */
  write(reg, payload = []) {
    return this.#enqueue(async () => {
      if (this.closed) throw new BmsProtocolError('соединение закрыто');
      this.rx = Buffer.alloc(0);
      const waiting = this.#waitFrame(reg, this.timeoutMs);
      await this.transport.write(buildWriteFrame(reg, payload));
      const frame = await waiting;
      if (frame.status !== 0x00) throw new BmsProtocolError(`BMS отклонил запись в регистр 0x${reg.toString(16)}`);
      return frame.data;
    });
  }

  async readBasicInfo() { return parseBasicInfo(await this.read(REG.BASIC_INFO)); }
  async readCellInfo() { return parseCellInfo(await this.read(REG.CELL_INFO)); }
  async readDeviceName() { return parseDeviceName(await this.read(REG.DEVICE_NAME)); }
  async readErrorCounters() { return parseErrorCounters(await this.read(REG.ERROR_COUNTS)); }

  /** Сырое значение настройки; decode задаёт масштаб (см. SETTINGS в jbd-protocol.mjs). */
  async readSetting(def) {
    const data = await this.read(def.reg);
    return decodeSetting(def, data);
  }

  async close() {
    this.closed = true;
    this.waiter = null;
    await this.transport.close();
  }
}
