// Прошивка BMS: проверка файла и (пока заблокированная) запись.
//
// Что уже работает:
//   • открыть .hex, проверить каждую строку и контрольные суммы, показать
//     размер, адреса, SHA-256 — и сравнить с версией, которую сообщает плата;
//   • прочитать текущую версию прошивки из регистра 0x03.
//
// Чего НЕТ и почему:
//   Запись прошивки по UART требует протокола загрузчика конкретной платы.
//   В открытых источниках (библиотека bms-tools помечает обновление прошивки
//   «Not planned», форумы DIY Solar) этого протокола нет, а неверная запись
//   выводит BMS из строя. Поэтому FIRMWARE_WRITE_PROTOCOL = null, и приложение
//   не отправляет в BMS ни одного байта прошивки, пока протокол не подтверждён
//   захватом обмена JBDTools с реальной платой.
//
// Чтобы подключить протокол, нужно заполнить FIRMWARE_WRITE_PROTOCOL объектом
// { enter(client), writeSegment(client, address, bytes), finish(client) }
// и обязательно проверить его на тестовой плате с отключённой нагрузкой.

import { parseIntelHex, MAX_FIRMWARE_BYTES } from './intel-hex.mjs';

export const FIRMWARE_WRITE_PROTOCOL = null;

export class FirmwareError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Проверка файла прошивки без записи в BMS.
 * @returns описание файла (без самих байт) и ошибки разбора
 */
export function inspectFirmwareFile(text, fileName = 'firmware.hex') {
  if (typeof text !== 'string' || !text.trim()) {
    throw new FirmwareError('EMPTY', 'Файл пустой.');
  }
  const parsed = parseIntelHex(text);
  // байты сегментов в ответ не отдаём — только адреса и размеры
  const { segments, ...summary } = parsed;
  return {
    fileName: String(fileName).slice(0, 200),
    ...summary,
    segments: segments.map(({ address, length }) => ({ address, length })),
    sizeKiB: Math.round((summary.bytes / 1024) * 10) / 10,
    maxKiB: MAX_FIRMWARE_BYTES / 1024,
    canWrite: parsed.ok && FIRMWARE_WRITE_PROTOCOL !== null,
    writeBlockedReason: writeBlockedReason(parsed.ok),
  };
}

function writeBlockedReason(fileOk) {
  if (!fileOk) return 'Файл не прошёл проверку.';
  if (FIRMWARE_WRITE_PROTOCOL === null) {
    return 'Запись прошивки по UART ещё не реализована: протокол загрузчика JBD не подтверждён. '
      + 'Прошивка не отправлялась в BMS.';
  }
  return null;
}

/**
 * Запись прошивки. Сейчас всегда отказывает с понятной причиной.
 * @param {object} client BmsClient
 * @param {ReturnType<typeof parseIntelHex>} image результат parseIntelHex с ok=true
 */
export async function flashFirmware(client, image) {
  if (!image || !image.ok || !image.segments?.length) {
    throw new FirmwareError('BAD_FILE', 'Файл прошивки не прошёл проверку.');
  }
  if (FIRMWARE_WRITE_PROTOCOL === null) {
    throw new FirmwareError('PROTOCOL_UNKNOWN', writeBlockedReason(true));
  }
  // Ветка для будущего подтверждённого протокола (см. комментарий выше).
  await FIRMWARE_WRITE_PROTOCOL.enter(client);
  for (const seg of image.segments) {
    await FIRMWARE_WRITE_PROTOCOL.writeSegment(client, seg.address, seg.bytes);
  }
  await FIRMWARE_WRITE_PROTOCOL.finish(client);
  return { ok: true };
}
