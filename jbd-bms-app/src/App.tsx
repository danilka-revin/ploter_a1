// Единая страница: подключение к батарее → заряд и разряд (схема и большие кнопки) →
// состояние → ячейки → управление → свёрнутые блоки настроек, прошивки и обновлений.
// Данные платы опрашиваются раз в секунду, пока подключено. Список портов обновляется сам.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, fmtClock, sleep } from './api';
import { pickPort } from './ports';
import type {
  AppState, ConnectResponse, Health, PortItem, PortsResponse, ScanResponse, Snapshot, UpdateSnapshot,
} from './types';
import { ConnectionCard } from './views/Connection';
import { PowerPanel } from './views/Power';
import { Overview } from './views/Overview';
import { Cells } from './views/Cells';
import { Control } from './views/Control';
import { Settings } from './views/Settings';
import { Firmware } from './views/Firmware';
import { UpdateDialog } from './views/UpdateDialog';
import { Icon } from './icons';

const THEME_KEY = 'jbd.theme';
const UPDATE_FIRST_MS = 4_000;
const UPDATE_EVERY_MS = 30 * 60_000;
const PORTS_EVERY_MS = 2_500;
const DEMO_LABEL = 'Демо-режим (без платы)';

function initialTheme(): 'dark' | 'light' {
  try {
    const s = globalThis.localStorage?.getItem(THEME_KEY);
    if (s === 'light' || s === 'dark') return s;
  } catch { /* приватный режим */ }
  return 'dark';
}

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(initialTheme);

  const [ports, setPorts] = useState<PortItem[]>([]);
  const [demoPort, setDemoPort] = useState<PortItem>({ path: 'demo', label: DEMO_LABEL });
  const [selected, setSelected] = useState('');
  // выбирал ли пользователь порт сам: если нет, список сам переключает демо на настоящий адаптер
  const userPicked = useRef(false);
  const [appState, setAppState] = useState<AppState | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [notice, setNotice] = useState<{ kind: 'err' | 'ok'; text: string } | null>(null);

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [pollError, setPollError] = useState('');
  const [lastOkAt, setLastOkAt] = useState(0);
  const inFlight = useRef(false);

  const [health, setHealth] = useState<Health | null>(null);
  const [update, setUpdate] = useState<UpdateSnapshot | null>(null);
  const [updOpen, setUpdOpen] = useState(false);

  // ----- тема -----
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { globalThis.localStorage?.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme]);

  // ----- порты и состояние -----
  const refreshPorts = useCallback(async (quiet = false) => {
    try {
      const r = await api<PortsResponse>('/api/ports');
      setPorts(r.ports);
      setDemoPort(r.demo);
      setSelected((cur) => pickPort(cur, r, userPicked.current));
    } catch (e: any) {
      if (!quiet) setNotice({ kind: 'err', text: e.message });
    }
  }, []);

  const refreshState = useCallback(async () => {
    try {
      setAppState(await api<AppState>('/api/state'));
    } catch (e: any) {
      setNotice({ kind: 'err', text: e.message });
    }
  }, []);

  useEffect(() => {
    api<Health>('/healthz').then(setHealth).catch(() => {});
    refreshPorts();
    refreshState();
  }, [refreshPorts, refreshState]);

  const connected = Boolean(appState?.connected);

  // пока плата не подключена, список портов обновляется сам: вставили адаптер — он появился
  useEffect(() => {
    if (connected) return;
    const id = setInterval(() => refreshPorts(true), PORTS_EVERY_MS);
    return () => clearInterval(id);
  }, [connected, refreshPorts]);

  // ----- подключение -----
  const connectTo = useCallback(async (path: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api<ConnectResponse>('/api/connect', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }, 20_000);
      setNotice({
        kind: 'ok',
        text: r.demo
          ? 'Демо-режим: данные эмулятора, плата не нужна.'
          : `Батарея подключена на порту ${path}: ${r.deviceName || 'BMS'}, ячеек: ${r.cellCount}.`,
      });
      setPollError('');
      await refreshState();
    } catch (e: any) {
      setNotice({ kind: 'err', text: e.message });
      await refreshState();
    } finally {
      setBusy(false);
    }
  }, [refreshState]);

  const connect = () => connectTo(selected);

  const disconnect = async () => {
    setBusy(true);
    try {
      await api('/api/disconnect', { method: 'POST' });
    } finally {
      setSnap(null);
      setBusy(false);
      await refreshState();
    }
  };

  // ----- поиск батареи по всем портам -----
  const findBattery = async () => {
    setScanning(true);
    setNotice(null);
    setScan(null);
    try {
      const r = await api<ScanResponse>('/api/scan', { method: 'POST' }, 90_000);
      setScan(r);
      if (r.found.length === 0) {
        setNotice({
          kind: 'err',
          text: r.results.length === 0
            ? 'USB–UART адаптер не найден. Вставьте его и нажмите «Найти батарею» ещё раз.'
            : 'Батарея не найдена ни на одном порту. Смотрите причины ниже.',
        });
      } else if (r.found.length === 1) {
        userPicked.current = true;
        setSelected(r.found[0]);
        await connectTo(r.found[0]);
      } else {
        userPicked.current = true;
        setSelected(r.found[0]);
        setNotice({ kind: 'ok', text: `Нашлось несколько батарей: ${r.found.join(', ')}. Выберите нужную кнопкой «Подключить» ниже.` });
      }
    } catch (e: any) {
      setNotice({ kind: 'err', text: e.message });
    } finally {
      setScanning(false);
      await refreshPorts(true);
    }
  };

  // ----- опрос платы -----
  useEffect(() => {
    if (!connected) { setSnap(null); return; }
    let alive = true;
    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const s = await api<Snapshot>('/api/snapshot', {}, 6_000);
        if (!alive) return;
        setSnap(s);
        setPollError('');
        setLastOkAt(Date.now());
      } catch (e: any) {
        if (!alive) return;
        setPollError(e.message);
        if (e instanceof ApiError && e.status === 502) refreshState();
      } finally {
        inFlight.current = false;
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(id); };
  }, [connected, refreshState]);

  // ----- обновления -----
  const checkUpdate = useCallback(async () => {
    try {
      setUpdate(await api<UpdateSnapshot>('/update/check', {}, 20_000));
    } catch { /* сервер недоступен — тихо */ }
  }, []);

  useEffect(() => {
    const first = setTimeout(checkUpdate, UPDATE_FIRST_MS);
    const every = setInterval(checkUpdate, UPDATE_EVERY_MS);
    return () => { clearTimeout(first); clearInterval(every); };
  }, [checkUpdate]);

  const runUpdate = async () => {
    try {
      setUpdate(await api<UpdateSnapshot>('/update/run', { method: 'POST' }));
    } catch (e: any) {
      setNotice({ kind: 'err', text: e.message });
    }
  };

  // после установки сервер перезапускается: ждём его и перезагружаем страницу
  useEffect(() => {
    if (!update || !update.restartRequired) return;
    let stop = false;
    (async () => {
      await sleep(2500);
      for (let i = 0; i < 90 && !stop; i++) {
        try {
          const h = await api<Health>('/healthz', {}, 2_000);
          if (h.ok) { location.reload(); return; }
        } catch { /* ещё перезапускается */ }
        await sleep(1000);
      }
    })();
    return () => { stop = true; };
  }, [update?.restartRequired]); // eslint-disable-line react-hooks/exhaustive-deps

  // опрос хода обновления, пока оно идёт
  useEffect(() => {
    if (!update || (update.phase !== 'running' && !update.running)) return;
    const id = setInterval(async () => {
      try { setUpdate(await api<UpdateSnapshot>('/update/status')); } catch { /* перезапуск */ }
    }, 1000);
    return () => clearInterval(id);
  }, [update?.phase, update?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateAvailable = Boolean(update?.updateAvailable);
  const b = snap?.basic;

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <span className="brandmark"><img src="logo.png" alt="" /></span>
          <span className="brandtext">
            <b>JBD <em>BMS</em></b>
            <small>ЧТЕНИЕ И УПРАВЛЕНИЕ · UART</small>
          </span>
        </div>

        <div className="tb-status">
          {connected && b ? (
            <span className="pill on"><span className="pulse" /> {b.packVoltage.toFixed(2)} В · {b.capacityPct}%</span>
          ) : (
            <span className="pill off"><span className="dot-off" /> не подключено</span>
          )}
        </div>

        <div className="toolbar-exit">
          <button
            className={`tb-btn wide upd-btn ${updateAvailable ? 'upd-avail' : ''}`}
            onClick={() => setUpdOpen(true)}
            title={updateAvailable ? 'Есть новая версия на GitHub' : 'Проверка обновлений'}
          >
            {updateAvailable && <span className="upd-dot is-new" />}
            <Icon name="download" />
            <span>{updateAvailable ? 'Обновить с main' : 'Обновления'}</span>
          </button>
          <button
            className="tb-btn"
            title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
        </div>
      </header>

      {notice && (
        <div className={`banner ${notice.kind} page-banner`} role="status">
          <span>{notice.text}</span>
          <button className="btn tiny" onClick={() => setNotice(null)}>Закрыть</button>
        </div>
      )}

      <main className="page">
        <ConnectionCard
          ports={ports}
          demoPort={demoPort}
          selected={selected}
          onSelect={(path) => { userPicked.current = true; setSelected(path); }}
          onRefresh={() => refreshPorts()}
          connected={connected}
          busy={busy}
          scanning={scanning}
          scan={scan}
          portName={appState?.port ?? null}
          demo={Boolean(appState?.demo)}
          deviceName={appState?.deviceName ?? ''}
          onConnect={connect}
          onDisconnect={disconnect}
          onFind={findBattery}
          onConnectPath={connectTo}
        />

        <PowerPanel
          snap={snap}
          connected={connected}
          port={appState?.port ?? null}
          demo={Boolean(appState?.demo)}
        />

        <section className="block" aria-labelledby="state-title">
          <div className="sec-head"><h2 id="state-title">3. Состояние батареи</h2></div>
          <Overview snap={snap} connected={connected} error={pollError} />
        </section>

        <section className="block" aria-labelledby="cells-title">
          <div className="sec-head"><h2 id="cells-title">4. Ячейки</h2></div>
          <Cells snap={snap} connected={connected} error={pollError} />
        </section>

        <section className="block" aria-labelledby="ctl-title">
          <div className="sec-head"><h2 id="ctl-title">5. Управление</h2></div>
          <Control snap={snap} connected={connected} />
        </section>

        <details className="block fold">
          <summary><span className="fold-title">6. Защиты и настройки платы</span><span className="muted small">читать и менять пороги (нужна осторожность)</span></summary>
          <div className="fold-body">
            <Settings connected={connected} />
          </div>
        </details>

        <details className="block fold">
          <summary><span className="fold-title">7. Прошивка</span><span className="muted small">проверка файла .hex</span></summary>
          <div className="fold-body">
            <Firmware connected={connected} snap={snap} onStateChange={refreshState} />
          </div>
        </details>
      </main>

      <footer className="status">
        <span className="lg">
          <span className={connected ? 'pulse' : 'dot-off'} />
          {connected
            ? (appState?.demo ? 'Демо-режим' : `Подключено: ${appState?.port}`)
            : 'Плата не подключена'}
        </span>
        {connected && snap && (
          <span>Батарея: <b>{snap.basic.packVoltage.toFixed(2)} В</b></span>
        )}
        {connected && lastOkAt > 0 && <span>Обновлено: <b>{fmtClock(lastOkAt)}</b></span>}
        <span className="sp" />
        {pollError && <span className="status-alert">{pollError}</span>}
        {appState?.lastError && !connected && !pollError && (
          <span className="status-alert">{appState.lastError}</span>
        )}
        <span>Версия {health?.app ?? '—'}{health?.commit ? ` · ${health.commit}` : ''}</span>
      </footer>

      {updOpen && (
        <UpdateDialog
          update={update}
          onClose={() => setUpdOpen(false)}
          onCheck={checkUpdate}
          onRun={runUpdate}
        />
      )}
    </div>
  );
}
