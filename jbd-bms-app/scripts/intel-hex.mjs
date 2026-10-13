// Разбор файла прошивки в формате Intel HEX (.hex) — так распространяются
// прошивки JBD (их открывает JBDTools). Проверяется каждая строка:
// префикс «:», длина, контрольная сумма записи, типы записей и наличие
// конца файла. Модуль только читает файл — ничего не пишет в BMS.

import { createHash } from 'node:crypto';

export const MAX_FIRMWARE_BYTES = 512 * 1024;

/**
 * @param {string} text содержимое .hex
 * @returns {{ ok: boolean, errors: string[], warnings: string[], segments: {address:number,length:number,bytes:Buffer}[],
 *            bytes: number, minAddress: number|null, maxAddress: number|null, records: number, sha256: string|null }}
 */
export function parseIntelHex(text) {
  const errors = [];
  const warnings = [];
  const memory = new Map(); // адрес -> байт
  let base = 0;             // сегмент/линейная база (типы 02 и 04)
  let records = 0;
  let sawEof = false;
  let startAddressRecord = false;

  const lines = String(text).split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line) continue;
    const lineNo = n + 1;
    if (sawEof) { warnings.push(`строка ${lineNo}: данные после записи конца файла проигнорированы`); break; }
    if (line[0] !== ':') { errors.push(`строка ${lineNo}: нет префикса «:»`); continue; }
    if (!/^:[0-9A-Fa-f]+$/.test(line) || line.length % 2 === 0) {
      errors.push(`строка ${lineNo}: строка содержит недопустимые символы или обрезана`);
      continue;
    }
    const bytes = [];
    for (let i = 1; i < line.length; i += 2) bytes.push(parseInt(line.substr(i, 2), 16));
    const count = bytes[0];
    if (bytes.length !== count + 5) {
      errors.push(`строка ${lineNo}: длина записи не совпадает (${count} байт данных)`);
      continue;
    }
    const sum = bytes.reduce((a, b) => (a + b) & 0xff, 0);
    if (sum !== 0) {
      errors.push(`строка ${lineNo}: неверная контрольная сумма записи`);
      continue;
    }
    records++;
    const addr = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    const data = bytes.slice(4, 4 + count);
    switch (type) {
      case 0x00: // данные
        for (let i = 0; i < data.length; i++) {
          const a = base + addr + i;
          if (memory.has(a) && memory.get(a) !== data[i]) {
            errors.push(`строка ${lineNo}: адрес 0x${a.toString(16).toUpperCase()} переписан с другим значением`);
          }
          memory.set(a, data[i]);
        }
        if (memory.size > MAX_FIRMWARE_BYTES) {
          errors.push(`размер прошивки больше ${MAX_FIRMWARE_BYTES / 1024} КБ — это не файл прошивки BMS`);
          return finish();
        }
        break;
      case 0x01: // конец файла
        sawEof = true;
        break;
      case 0x02: // сегмент: адрес * 16
        if (count !== 2) errors.push(`строка ${lineNo}: неверная запись сегмента`);
        else base = ((data[0] << 8) | data[1]) * 16;
        break;
      case 0x04: // линейная база старших 16 бит
        if (count !== 2) errors.push(`строка ${lineNo}: неверная запись линейного адреса`);
        else base = ((data[0] << 8) | data[1]) * 0x10000;
        break;
      case 0x03:
      case 0x05:
        startAddressRecord = true;
        break;
      default:
        errors.push(`строка ${lineNo}: неизвестный тип записи 0x${type.toString(16).padStart(2, '0')}`);
    }
  }

  if (!sawEof) errors.push('нет записи конца файла (:00000001FF) — файл обрезан');
  if (!startAddressRecord) warnings.push('нет записи стартового адреса (необязательно для прошивки BMS)');
  if (memory.size === 0) errors.push('в файле нет данных прошивки');
  return finish();

  function finish() {
    const addrs = [...memory.keys()].sort((a, b) => a - b);
    // непрерывные участки памяти; у каждого свои байты (разрывы адресов сохраняются)
    const segments = [];
    let cur = null;
    for (const a of addrs) {
      if (cur && a === cur.address + cur.bytes.length) { cur.bytes.push(memory.get(a)); continue; }
      cur = { address: a, bytes: [memory.get(a)] };
      segments.push(cur);
    }
    const blocks = segments.map((s) => ({ address: s.address, length: s.bytes.length, bytes: Buffer.from(s.bytes) }));
    const all = blocks.length ? Buffer.concat(blocks.map((b) => b.bytes)) : null;
    const ok = errors.length === 0;
    return {
      ok,
      errors,
      warnings,
      segments: blocks,
      bytes: memory.size,
      minAddress: addrs.length ? addrs[0] : null,
      maxAddress: addrs.length ? addrs[addrs.length - 1] : null,
      records,
      sha256: all && ok ? createHash('sha256').update(all).digest('hex') : null,
    };
  }
}
