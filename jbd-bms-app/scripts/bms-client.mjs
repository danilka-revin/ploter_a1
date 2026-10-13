// Клиент JBD-протокола поверх любого транспорта с интерфейсом:
//   transport.write(Buffer) → Promise
//   transport.onData(cb(Buffer))   — подписка на входящие байты
//   transport.close() → Promise
// Запросы выполняются строго по одному (очередь): BMS отвечает на один кадр
// за раз, и параллельные запросы перепутали бы ответы. Запись настроек — одна
// операция в очереди целиком, чтобы опрос не попал внутрь заводского режима.

import {
  buildReadFrame, buildWriteFrame, extractResponses, BmsProtocolError,
  REG, parseBasicInfo, parseCellInfo, parseDeviceName, parseErrorCounters, decodeSetting,
  WRITE_REG, FACTORY_ENTER, FACTORY_EXIT_SAVE, FACTORY_EXIT_DISCARD, passwordBytes,
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

  /** Все публичные операции — через очередь. */
  #enqueue(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  #waitFrame(reg, timeoutMs) {
    let cancel = () => {};
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter && this.waiter.reg === reg) this.waiter = null;
        reject(new BmsProtocolError('BMS не ответил'));
      }, timeoutMs);
      this.waiter = {
        reg,
        resolve: (frame) => { clearTimeout(timer); resolve(frame); },
      };
      // отменяем ожидание, если запрос не ушёл в порт: иначе таймер позже
      // породит неиспользованное отклонение (шум в логах и в тестах)
      cancel = () => {
        clearTimeout(timer);
        if (this.waiter && this.waiter.reg === reg) this.waiter = null;
      };
    });
    return { promise, cancel };
  }

  /** Чтение без очереди — вызывать только изнутри операции из очереди. */
  async #readNow(reg, payload = []) {
    if (this.closed) throw new BmsProtocolError('соединение закрыто');
    let lastErr = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      this.rx = Buffer.alloc(0);
      const waiting = this.#waitFrame(reg, this.timeoutMs);
      try {
        await this.transport.write(buildReadFrame(reg, payload));
      } catch (e) {
        waiting.cancel();
        throw e;
      }
      try {
        const frame = await waiting.promise;
        if (frame.status !== 0x00) {
          throw new BmsProtocolError(`BMS вернул статус 0x${frame.status.toString(16).padStart(2, '0')} для регистра 0x${reg.toString(16).padStart(2, '0')}`);
        }
        return frame.data;
      } catch (e) {
        waiting.cancel();
        if (e instanceof BmsProtocolError && e.message === 'BMS не ответил') { lastErr = e; continue; }
        throw e;
      }
    }
    throw lastErr;
  }

  /** Запись без очереди — вызывать только изнутри операции из очереди. */
  async #writeNow(reg, payload = []) {
    if (this.closed) throw new BmsProtocolError('соединение закрыто');
    this.rx = Buffer.alloc(0);
    const waiting = this.#waitFrame(reg, this.timeoutMs);
    try {
      await this.transport.write(buildWriteFrame(reg, payload));
    } catch (e) {
      waiting.cancel();
      throw e;
    }
    let frame;
    try {
      frame = await waiting.promise;
    } catch (e) {
      waiting.cancel();
      throw e;
    }
    if (frame.status !== 0x00) throw new BmsProtocolError(`BMS отклонил запись в регистр 0x${reg.toString(16)}`);
    return frame.data;
  }

  /**
   * Чтение регистра. Возвращает данные ответа (Buffer).
   * @throws BmsProtocolError при таймауте, ошибке статуса (0x80) или неверном ответе
   */
  read(reg, payload = []) {
    return this.#enqueue(() => this.#readNow(reg, payload));
  }

  /** Сырое 16-битное значение настройки (для проверки после записи). */
  readRaw(def) {
    return this.#enqueue(async () => {
      const data = await this.#readNow(def.reg);
      if (data.length < 2) throw new BmsProtocolError(`регистр 0x${def.reg.toString(16)}: короткий ответ`);
      return data.readUInt16BE(0);
    });
  }

  /**
   * Атомарная запись настроек в заводском режиме (как в bms-tools):
   * пароль → вход (00 ← 56 78) → записи (2 байта BE на регистр) → выход
   * (01 ← 28 28 с сохранением в память платы или 00 00 без сохранения).
   * Если запись прервалась — выходим БЕЗ сохранения, чтобы не закрепить частичные значения.
   * @param {Array<{reg:number, raw:number}>} entries  сырые 16-битные значения (см. settingToRaw)
   * @returns {Promise<{written:number, saved:boolean}>}
   */
  writeSettings(entries, { save = true, password = '' } = {}) {
    const pwd = passwordBytes(password); // ошибка формата пароля — до обращения к плате
    return this.#enqueue(async () => {
      if (this.closed) throw new BmsProtocolError('соединение закрыто');
      try {
        await this.#writeNow(WRITE_REG.PASSWORD, [6, ...pwd]);
      } catch {
        throw new BmsProtocolError('BMS отклонил пароль: проверьте пароль платы');
      }
      await this.#enterFactoryNow();
      let ok = false;
      try {
        for (const e of entries) {
          await this.#writeNow(e.reg, [(e.raw >> 8) & 0xff, e.raw & 0xff]);
        }
        ok = true;
      } finally {
        const exitData = ok && save ? FACTORY_EXIT_SAVE : FACTORY_EXIT_DISCARD;
        try {
          await this.#writeNow(WRITE_REG.EXIT, exitData);
        } catch (exitErr) {
          if (ok) throw exitErr; // записи прошли, а выход не подтвердился — сообщаем явно
        }
      }
      return { written: entries.length, saved: ok && save };
    });
  }

  async #enterFactoryNow() {
    // несколько попыток: плата иногда не отвечает на первый кадр сразу после пароля
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.#writeNow(WRITE_REG.FACTORY, FACTORY_ENTER);
        return;
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    throw new BmsProtocolError(`BMS не вошёл в заводской режим: ${last?.message ?? 'нет ответа'}`);
  }

  /** Запись регистра (без заводского режима). Оставлена для совместимости и тестов. */
  write(reg, payload = []) {
    return this.#enqueue(() => this.#writeNow(reg, payload));
  }

  async readBasicInfo() { return parseBasicInfo(await this.read(REG.BASIC_INFO)); }
  async readCellInfo() { return parseCellInfo(await this.read(REG.CELL_INFO)); }
  async readDeviceName() { return parseDeviceName(await this.read(REG.DEVICE_NAME)); }
  async readErrorCounters() { return parseErrorCounters(await this.read(REG.ERROR_COUNTS)); }

  /** Значение настройки в единицах интерфейса; decode задаёт масштаб (см. SETTINGS в jbd-protocol.mjs). */
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
