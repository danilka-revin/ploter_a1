// Поиск батареи по портам: открываем каждый последовательный порт по очереди,
// спрашиваем у платы базовую информацию и закрываем порт. Так пользователю не нужно
// угадывать, на каком COM-порту или /dev/ttyUSB* сидит BMS.
//
// Результат по каждому порту:
//   found: true   — плата ответила (есть данные о батарее);
//   found: false, reason: 'busy'   — порт не открылся (занят другой программой или нет прав);
//   found: false, reason: 'silent' — порт открылся, но плата не ответила (не BMS, не тот адаптер,
//                                    перепутаны TX/RX или не подано питание на плату).

import { BmsClient } from './bms-client.mjs';
import { openSerialTransport } from './serial-transport.mjs';

const SCAN_TIMEOUT_MS = 600;
const SCAN_RETRIES = 1;

/**
 * @param {{ path: string, label?: string }[]} ports  список портов (без пункта «демо»)
 * @param {{ open?: (path: string) => Promise<object> }} [opts] open — способ открыть порт (для тестов)
 */
export async function scanBmsPorts(ports, { open = openSerialTransport } = {}) {
  const results = [];
  for (const p of ports) {
    const item = { path: p.path, label: p.label || p.path, found: false, reason: '', deviceName: '', cellCount: 0, firmwareVersion: 0, detail: '' };
    let transport = null;
    let client = null;
    try {
      transport = await open(p.path);
    } catch (e) {
      item.reason = 'busy';
      item.detail = e.message;
      results.push(item);
      continue;
    }
    try {
      client = new BmsClient(transport, { timeoutMs: SCAN_TIMEOUT_MS, retries: SCAN_RETRIES });
      const basic = await client.readBasicInfo();
      item.found = true;
      item.cellCount = basic.cellCount;
      item.firmwareVersion = basic.firmwareVersion;
      try { item.deviceName = await client.readDeviceName(); } catch { /* имени может не быть */ }
    } catch (e) {
      item.reason = 'silent';
      item.detail = e.message;
    } finally {
      try {
        if (client) await client.close();
        else if (transport) await transport.close();
      } catch { /* порт уже закрыт */ }
    }
    results.push(item);
  }
  return results;
}
