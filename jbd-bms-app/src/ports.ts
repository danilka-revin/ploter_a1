// Выбор порта в списке. Главное правило: если пользователь сам не выбирал «демо»,
// демо-режим не должен залипать, когда в системе появился настоящий адаптер.
import type { PortsResponse } from './types';

export function pickPort(current: string, list: PortsResponse, userChose: boolean): string {
  const real = list.ports.map((p) => p.path);
  if (current && real.includes(current)) return current;          // выбранный порт всё ещё на месте
  if (current === list.demo.path && userChose) return current;    // демо выбрано пользователем — оставляем
  return real[0] ?? list.demo.path;                                // иначе — первый настоящий порт, демо только если портов нет
}
