// Состояние панели: один источник правды для всех плиток.
//
//  • раз в pollMs тянет /api/panel (строки банков, итоги парка, ряды графиков);
//  • держит каталог регистров, список портов, выбранный банк и окно графика;
//  • наружу отдаёт действия (подключить банк, записать настройки, команды, консоль),
//    которые сами обновляют данные и пишут строки в журнал.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type {
  BankRegisters, BankRow, Catalog, ControlResponse, Panel, PortItem, PrinterStatus, RawReadResponse, RawWriteResponse, Series,
} from './types';

const WINDOW_KEY = 'jbd.window';
const FOCUS_KEY = 'jbd.focus';
const WINDOW_OPTIONS = [120, 300, 900, 3600];

export interface LogItem { at: number; kind: 'ok' | 'err' | 'info'; text: string }

function loadWindow(): number {
  try {
    const raw = Number(globalThis.localStorage?.getItem(WINDOW_KEY));
    if (WINDOW_OPTIONS.includes(raw)) return raw;
  } catch { /* приватный режим */ }
  return 900;
}

export function useCockpit() {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [ports, setPorts] = useState<PortItem[]>([]);
  const [demoPort, setDemoPort] = useState<PortItem>({ path: 'demo', label: 'Демо-режим (без платы)' });
  const [selected, setSelected] = useState('demo');
  const [windowSec, setWindowSec] = useState(loadWindow);
  const [focus, setFocusState] = useState<string | null>(null);
  const [registers, setRegisters] = useState<BankRegisters | null>(null);
  const [log, setLog] = useState<LogItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pollMs, setPollMs] = useState(1000);
  const [scanning, setScanning] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const note = useCallback((kind: LogItem['kind'], text: string) => {
    setLog((cur) => [{ at: Date.now(), kind, text }, ...cur].slice(0, 120));
    if (kind === 'err') setError(text);
    if (kind !== 'err') setError('');
  }, []);

  // ----- данные панели -----
  const refresh = useCallback(async (id?: string | null) => {
    try {
      const p = await api<Panel>(`/api/panel?window=${windowSec}${id ? `&focus=${encodeURIComponent(id)}` : ''}`, {}, 8000);
      if (!alive.current) return p;
      setPanel(p);
      if (p.pollMs) setPollMs(p.pollMs);
      return p;
    } catch (e: any) {
      if (alive.current) note('err', e.message ?? 'Нет связи с сервером');
      return null;
    }
  }, [windowSec, note]);

  useEffect(() => {
    api<Catalog>('/api/catalog').then((c) => { if (alive.current) setCatalog(c); }).catch(() => {});
  }, []);

  const refreshPorts = useCallback(async () => {
    try {
      const r = await api<{ ports: PortItem[]; demo: PortItem }>('/api/ports', {}, 8000);
      if (!alive.current) return;
      setPorts(r.ports);
      setDemoPort(r.demo);
      // порт принтера в списке есть (он нужен плитке принтера), но платой по умолчанию не выбираем
      const firstFree = () => (r.ports.find((p) => !p.printer)?.path ?? r.ports[0]?.path ?? 'demo');
      setSelected((cur) => (cur && cur !== 'demo' && !r.ports.some((p) => p.path === cur) ? firstFree() : (cur || firstFree())));
    } catch { /* сервер ещё не поднялся */ }
  }, []);

  useEffect(() => { refreshPorts(); }, [refreshPorts]);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (!stop) await refresh(focus);
    };
    tick();
    const id = setInterval(tick, Math.max(400, pollMs));
    return () => { stop = true; clearInterval(id); };
  }, [refresh, focus, pollMs]);

  // выбранное окно графика помним между запусками
  useEffect(() => {
    try { globalThis.localStorage?.setItem(WINDOW_KEY, String(windowSec)); } catch { /* ignore */ }
  }, [windowSec]);

  useEffect(() => {
    try {
      if (focus) globalThis.localStorage?.setItem(FOCUS_KEY, focus);
    } catch { /* ignore */ }
  }, [focus]);

  // если банк пропал (отключили) — снимаем фокус
  useEffect(() => {
    if (!panel) return;
    if (focus && !panel.banks.some((b) => b.id === focus)) setFocusState(null);
    if (!focus && panel.banks.length) {
      let saved: string | null = null;
      try { saved = globalThis.localStorage?.getItem(FOCUS_KEY) ?? null; } catch { /* ignore */ }
      if (saved && panel.banks.some((b) => b.id === saved)) setFocusState(saved);
    }
  }, [panel, focus]);

  const focusBank: BankRow | null = useMemo(() => {
    if (!panel?.banks.length) return null;
    return panel.banks.find((b) => b.id === focus) ?? panel.banks[0];
  }, [panel, focus]);

  const series: Series | null = useMemo(() => {
    if (!panel) return null;
    if (focus === '__fleet__') return panel.fleetSeries;
    return panel.series ?? panel.fleetSeries;
  }, [panel, focus]);

  const setFocus = useCallback((id: string | null) => setFocusState(id), []);

  // ----- данные одного банка (сводка, настройки) -----
  const readRegisters = useCallback(async (id: string | null) => {
    const target = id ?? focusBank?.id ?? null;
    if (!target) { note('err', 'Нет подключённого банка.'); return null; }
    setBusy('registers');
    try {
      const r = await api<BankRegisters>(`/api/bank/registers?id=${encodeURIComponent(target)}`, {}, 120_000);
      if (alive.current) setRegisters(r);
      note('ok', `Банк ${labelOf(panel, target)}: параметры банок и настройки загружены.`);
      return r;
    } catch (e: any) {
      note('err', e.message ?? 'Не удалось прочитать данные платы');
      return null;
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [focusBank, note, panel]);

  // читаем регистры, когда выбрали банк и плитка настроек открыта
  useEffect(() => {
    if (registers && registers.id === focusBank?.id) return;
    if (focusBank?.connected) readRegisters(focusBank.id);
  }, [focusBank?.id, focusBank?.connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- банки -----
  const addBank = useCallback(async (path: string, label = '') => {
    setBusy('connect');
    try {
      const r = await api<{ id: string; label: string; cellCount: number; deviceName: string }>('/api/banks/add', { method: 'POST', body: JSON.stringify({ path, label }) }, 30_000);
      note('ok', `Банк ${r.label ?? path}: ${r.deviceName || 'BMS'}, ячеек ${r.cellCount}.`);
      setFocus(r.id);
      setRegisters(null);
      await refresh(r.id);
      await refreshPorts();
      return r;
    } catch (e: any) {
      note('err', e.message ?? 'Не удалось подключить банк');
      return null;
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [note, refresh, refreshPorts]);

  const addDemo = useCallback(async () => {
    setBusy('demo');
    try {
      const r = await api<{ added: { id: string; label: string }[] }>('/api/banks/demo', { method: 'POST', body: JSON.stringify({ count: 4 }) }, 30_000);
      note('ok', `Демо: подключено банков — ${r.added.length}. Плата не нужна.`);
      await refresh(r.added[0]?.id ?? null);
      return r;
    } catch (e: any) {
      note('err', e.message ?? 'Демо не запустилось');
      return null;
    } finally { if (alive.current) setBusy(null); }
  }, [note, refresh]);

  const findAndConnectAll = useCallback(async () => {
    setScanning(true);
    try {
      const r = await api<{ added: { id: string; path: string; label: string }[]; skipped: { path: string; reason: string }[]; scanned: number }>(
        '/api/banks/auto', { method: 'POST' }, 180_000);
      if (r.added.length) note('ok', `Найдено и подключено банков: ${r.added.length} (${r.added.map((a) => a.path).join(', ')}).`);
      else note('err', r.scanned ? 'Ни на одном порту BMS не ответила. Проверьте TX/RX и 3,3 В.' : 'USB–UART адаптеры не найдены.');
      for (const s of r.skipped ?? []) note('info', `${s.path}: ${s.reason}`);
      await refresh(r.added[0]?.id ?? null);
      await refreshPorts();
      return r;
    } catch (e: any) {
      note('err', e.message ?? 'Поиск не выполнен');
      return null;
    } finally {
      if (alive.current) setScanning(false);
    }
  }, [note, refresh, refreshPorts]);

  const removeBank = useCallback(async (id: string) => {
    await api('/api/banks/remove', { method: 'POST', body: JSON.stringify({ id }) }, 20_000).catch((e: any) => note('err', e.message));
    if (focus === id) setFocus(null);
    setRegisters(null);
    note('info', `Банк ${id} отключён.`);
    await refresh();
    await refreshPorts();
  }, [focus, note, refresh, refreshPorts, setFocus]);

  const renameBank = useCallback(async (id: string, label: string) => {
    await api('/api/banks/rename', { method: 'POST', body: JSON.stringify({ id, label }) }).catch((e: any) => note('err', e.message));
    await refresh(focus);
  }, [focus, note, refresh]);

  const reconnectBank = useCallback(async (id: string) => {
    setBusy('reconnect');
    try {
      await api('/api/banks/reconnect', { method: 'POST', body: JSON.stringify({ id }) }, 30_000);
      note('ok', 'Порт переоткрыт, связь есть.');
      setRegisters(null);
    } catch (e: any) {
      note('err', e.message ?? 'Переподключение не удалось');
    } finally { if (alive.current) setBusy(null); }
    await refresh(focus);
  }, [focus, note, refresh]);

  const setRate = useCallback(async (ms: number) => {
    setPollMs(ms);
    await api('/api/poll', { method: 'POST', body: JSON.stringify({ ms }) }).catch((e: any) => note('err', e.message));
    await refresh(focus);
  }, [focus, note, refresh]);

  // ----- запись настроек и команды -----
  const writeSettings = useCallback(async (changes: Record<string, number>, opts: { password?: string; save?: boolean; risk?: boolean }) => {
    const id = registers?.id ?? focusBank?.id;
    if (!id) { note('err', 'Нет подключённого банка.'); return null; }
    setBusy('write');
    try {
      const r = await api<{ ok: boolean; message: string; changed: number }>('/api/bank/settings/write', {
        method: 'POST',
        body: JSON.stringify({ id, changes, confirm: true, password: opts.password ?? '', save: opts.save !== false, risk: opts.risk === true }),
      }, 180_000);
      note(r.ok ? 'ok' : 'err', r.message);
      await readRegisters(id);
      await refresh(focus);
      return r;
    } catch (e: any) {
      note('err', e.message ?? 'Запись не выполнена');
      return null;
    } finally { if (alive.current) setBusy(null); }
  }, [focus, focusBank, note, readRegisters, refresh, registers]);

  const control = useCallback(async (action: string, payload: Record<string, unknown> = {}, all = false): Promise<ControlResponse | null> => {
    const id = all ? 'all' : (focusBank?.id ?? null);
    if (!id) { note('err', 'Нет подключённого банка.'); return null; }
    setBusy(action);
    try {
      const r = await api<ControlResponse>('/api/bank/control', { method: 'POST', body: JSON.stringify({ id, action, confirm: true, ...payload }) }, 90_000);
      const bad = r.results.filter((x) => x.ok === false);
      note(bad.length ? 'err' : 'ok', bad.length ? bad.map((b) => `${b.label}: ${b.message ?? 'не подтверждено'}`).join('; ') : (r.results[0]?.message ?? 'Готово.'));
      await refresh(focus);
      return r;
    } catch (e: any) {
      note('err', e.message ?? 'Команда не выполнена');
      return null;
    } finally { if (alive.current) setBusy(null); }
  }, [focus, focusBank, note, refresh]);

  const rawRead = useCallback(async (regs: number[], id?: string | null): Promise<RawReadResponse | null> => {
    const target = id ?? focusBank?.id;
    if (!target) { note('err', 'Нет подключённого банка.'); return null; }
    setBusy('raw');
    try {
      const r = await api<RawReadResponse>('/api/bank/raw/read', { method: 'POST', body: JSON.stringify({ id: target, regs }) }, 120_000);
      if (r.items.some((i) => !i.ok)) note('info', `Отвечают не все регистры: ${r.items.filter((i) => i.ok).length} из ${r.items.length}.`);
      return r;
    } catch (e: any) {
      note('err', e.message ?? 'Чтение не выполнено');
      return null;
    } finally { if (alive.current) setBusy(null); }
  }, [focusBank, note]);

  const rawWrite = useCallback(async (body: { reg: number; raw?: number; bytes?: number[]; factory?: boolean; password?: string; risk?: boolean }): Promise<RawWriteResponse | null> => {
    const id = focusBank?.id;
    if (!id) { note('err', 'Нет подключённого банка.'); return null; }
    setBusy('raw-write');
    try {
      const r = await api<RawWriteResponse>('/api/bank/raw/write', {
        method: 'POST',
        body: JSON.stringify({ id, ...body, confirm: true, risk: body.risk === true }),
      }, 60_000);
      note('ok', r.message);
      return r;
    } catch (e: any) {
      note('err', e.message ?? 'Запись не выполнена');
      return null;
    } finally { if (alive.current) setBusy(null); }
  }, [focusBank, note]);

  // ----- резервные копии и отчёт -----
  const backup = useCallback(async () => {
    const id = registers?.id ?? focusBank?.id;
    if (!id) { note('err', 'Нет подключённого банка.'); return; }
    try {
      const r = await api<object>(`/api/backup?id=${encodeURIComponent(id)}`, {}, 120_000);
      download(`bms-backup-${id}.json`, JSON.stringify(r, null, 2), 'application/json');
      note('ok', 'Резервная копия настроек сохранена в файл.');
    } catch (e: any) {
      note('err', e.message ?? 'Копия не создана');
    }
  }, [focusBank, note, registers]);

  const restore = useCallback(async (file: File | null) => {
    if (!file) return;
    const id = registers?.id ?? focusBank?.id;
    let parsed: any = null;
    try { parsed = JSON.parse(await file.text()); } catch { note('err', 'Файл копии — не JSON.'); return; }
    setBusy('restore');
    try {
      const dry = await api<any>('/api/backup/restore', { method: 'POST', body: JSON.stringify({ id, file: parsed, dryRun: true }) }, 180_000);
      const go = await api<any>('/api/backup/restore', {
        method: 'POST',
        body: JSON.stringify({ id, file: parsed, dryRun: false, confirm: true, risk: true, save: true }),
      }, 180_000);
      note(go.ok ? 'ok' : 'err', `${go.message} Изменений из копии: ${dry.changes?.length ?? 0}, пропущено: ${dry.skipped?.length ?? 0}.`);
      await readRegisters(id ?? null);
      await refresh(focus);
    } catch (e: any) {
      note('err', e.message ?? 'Восстановление не выполнено');
    } finally { if (alive.current) setBusy(null); }
  }, [focus, note, readRegisters, refresh, registers]);

  const exportCsv = useCallback(async () => {
    try {
      const text = await fetch('/api/report.csv', { cache: 'no-store' }).then(async (r) => {
        if (!r.ok) throw new ApiError((await r.text()) || 'Отчёт не сформирован', 'REPORT', r.status);
        return r.text();
      });
      download('bms-report.csv', text, 'text/csv');
      note('ok', 'Отчёт по всем банкам выгружен в CSV.');
    } catch (e: any) {
      note('err', e.message ?? 'Отчёт не выгружен');
    }
  }, [note]);

  const exportJson = useCallback(async () => {
    try {
      const r = await fetch('/api/report', { cache: 'no-store' });
      if (!r.ok) throw new Error('отчёт не сформирован');
      download('bms-report.json', JSON.stringify(await r.json(), null, 2), 'application/json');
      note('ok', 'Полный отчёт (JSON) сохранён.');
    } catch (e: any) {
      note('err', e.message ?? 'Отчёт не выгружен');
    }
  }, [note]);

  // ----- чековый принтер -----
  const printerStatus = useCallback(async (): Promise<PrinterStatus | null> => {
    try { return await api<PrinterStatus>('/api/printer'); }
    catch (e: any) { note('err', e.message ?? 'Не удалось получить статус принтера.'); return null; }
  }, [note]);

  const printerConfig = useCallback(async (patch: Record<string, unknown>): Promise<PrinterStatus | null> => {
    setBusy('printer-cfg');
    try {
      const s = await api<PrinterStatus>('/api/printer/config', { method: 'POST', body: JSON.stringify(patch) }, 10_000);
      note('ok', `Принтер: ${s.path || 'порт не выбран'} @ ${s.baudRate}.`);
      if (s.freedPort) note('info', `Порт ${s.freedPort} отключён от опроса платы — теперь это порт принтера (иначе опрос печатался бы вместо чека).`);
      refreshPorts();
      return s;
    } catch (e: any) { note('err', e.message ?? 'Настройки принтера не сохранены.'); return null; }
    finally { if (alive.current) setBusy(null); }
  }, [note, refreshPorts]);

  const printerTest = useCallback(async () => {
    setBusy('printer-test');
    try {
      const r = await api<any>('/api/printer/test', { method: 'POST' }, 20_000);
      note('ok', `Пробный чек напечатан (${r.path} @ ${r.baudRate}).`);
    } catch (e: any) { note('err', e.message ?? 'Печать не удалась'); }
    finally { if (alive.current) setBusy(null); }
  }, [note]);

  const printSummary = useCallback(async (id: string) => {
    setBusy('printer');
    try {
      const r = await api<any>('/api/printer/print', { method: 'POST', body: JSON.stringify({ id }) }, 30_000);
      if (r.banks != null) note('ok', `Сводка по парку (${r.banks} плат) отправлена на печать.`);
      else note('ok', `Сводка по «${r.bank ?? 'аккумулятору'}» отправлена на печать.`);
    } catch (e: any) { note('err', e.message ?? 'Печать сводки не удалась'); }
    finally { if (alive.current) setBusy(null); }
  }, [note]);

  const setBusyExt = useCallback((k: string | null) => setBusy(k), []);

  return {
    panel, catalog, ports, demoPort, selected, setSelected, windowSec, setWindowSec, WINDOW_OPTIONS,
    focus, setFocus, focusBank, series, registers, log, busy, error, pollMs, scanning,
    refresh, refreshPorts, addBank, addDemo, findAndConnectAll, removeBank, renameBank, reconnectBank, setRate,
    readRegisters, writeSettings, control, rawRead, rawWrite, backup, restore, exportCsv, exportJson, note,
    printerStatus, printerConfig, printerTest, printSummary, setBusy: setBusyExt,
  };
}

function labelOf(panel: Panel | null, id: string) {
  return panel?.banks.find((b) => b.id === id)?.label ?? id;
}

/** Сохранение файла на компьютере пользователя (без загрузки на сервер). */
export function download(name: string, text: string, type: string) {
  if (typeof document === 'undefined') return;
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
