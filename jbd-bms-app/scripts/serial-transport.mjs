// Транспорт UART для BMS: последовательный порт 9600 8N1 без управления потоком
// (так работает JBD). Интерфейс совпадает с тем, что ждёт BmsClient.
//
// Список портов: на Ubuntu — через udev (serialport). Если udev недоступен,
// показываем типичные USB-UART адаптеры: /dev/ttyUSB*, /dev/ttyACM*.

import { readdir } from 'node:fs/promises';
import { SerialPort } from 'serialport';

export const BMS_BAUD = 9600;

/** Список доступных последовательных портов для выпадающего списка. */
export async function listSerialPorts() {
  try {
    const list = await SerialPort.list();
    return list
      .filter((p) => p.path && !p.path.startsWith('/dev/ttyS'))
      .map((p) => ({
        path: p.path,
        label: [p.path, p.manufacturer, p.vendorId && p.productId ? `${p.vendorId}:${p.productId}` : '']
          .filter(Boolean).join(' · '),
      }));
  } catch {
    return fallbackPorts();
  }
}

async function fallbackPorts() {
  try {
    const names = await readdir('/dev');
    return names
      .filter((n) => /^(ttyUSB|ttyACM|ttyAMA)\d+$/.test(n))
      .sort()
      .map((n) => ({ path: `/dev/${n}`, label: `/dev/${n}` }));
  } catch {
    return [];
  }
}

/**
 * Открывает порт и возвращает транспорт для BmsClient.
 * @param {string} path например /dev/ttyUSB0
 */
export function openSerialTransport(path, { baudRate = BMS_BAUD } = {}) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({
      path,
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: false,
      xon: false,
      xoff: false,
      autoOpen: false,
    });
    const dataListeners = [];
    const closeListeners = [];
    let closedByUs = false;

    port.on('data', (chunk) => { for (const l of dataListeners) l(chunk); });
    port.on('close', () => { for (const l of closeListeners) l(closedByUs); });
    port.on('error', () => { /* ошибки передаются через write/open и событие close */ });

    port.open((err) => {
      if (err) {
        reject(new Error(`не удалось открыть ${path}: ${err.message}`));
        return;
      }
      resolve({
        path,
        get isOpen() { return port.isOpen; },
        onData(cb) { dataListeners.push(cb); },
        onClose(cb) { closeListeners.push(cb); },
        write(buf) {
          return new Promise((res, rej) => {
            port.write(buf, (e) => {
              if (e) { rej(e); return; }
              port.drain((de) => (de ? rej(de) : res()));
            });
          });
        },
        close() {
          return new Promise((res) => {
            if (!port.isOpen) { res(); return; }
            closedByUs = true;
            port.close(() => res());
          });
        },
      });
    });
  });
}
