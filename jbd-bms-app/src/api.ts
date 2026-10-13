// Тонкий клиент к локальному API. Все адреса относительные: интерфейс и API
// отдаются одним сервером, браузер никуда, кроме него, не обращается.

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function api<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, {
      cache: 'no-store',
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers || {}) },
      signal: ctl.signal,
    });
    const text = await r.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    if (!r.ok) throw new ApiError(data.message || `Ошибка ${r.status}`, data.error || 'ERROR', r.status);
    return data as T;
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new ApiError('Сервер не ответил вовремя.', 'TIMEOUT', 0);
    if (e instanceof ApiError) throw e;
    throw new ApiError('Нет связи с локальным сервером JBD BMS. Запустите его через run-windows.cmd или bash run.sh', 'NETWORK', 0);
  } finally {
    clearTimeout(timer);
  }
}

export function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 Б';
  if (n < 1024) return `${Math.round(n)} Б`;
  return `${(n / 1024).toFixed(1)} КБ`;
}

/** Время в «ЧЧ:ММ:СС» по локальному часовому поясу. */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDate(y: number, m: number, d: number): string {
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
