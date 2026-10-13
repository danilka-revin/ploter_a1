// Главный экран: шапка (порт, подключение, обновление, тема), вкладки и строка
// состояния. Данные платы опрашиваются раз в секунду, пока подключено.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, fmtClock, sleep } from './api';
import type {
  AppState, ConnectResponse, Health, PortItem, PortsResponse, Snapshot, UpdateSnapshot,
} from './types';
import { Overview } from './views/Overview';
import { Cells } from './views/Cells';
import { Settings } from './views/Settings';
import { Firmware } from './views/Firmware';
import { UpdateDialog } from './views/UpdateDialog';
import { Icon } from './icons';

type Tab = 'overview' | 'cells' | 'settings' | 'firmware';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Обзор' },
  { id: 'cells', label: 'Ячейки' },
  { id: 'settings', label: 'Защиты и настройки' },
  { id: 'firmware', label: 'Прошивка' },
];

const THEME_KEY = 'jbd.theme';
const UPDATE_FIRST_MS = 4_000;
const UPDATE_EVERY_MS = 30 * 60_000;

function initialTheme(): 'dark' | 'light' {
  try {
    const s = globalThis.localStorage?.getItem(THEME_KEY);
    if (s === 'light' || s === 'dark') return s;
  } catch { /* приватный режим */ }
  return 'dark';
}

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(initialTheme);
  const [tab, setTab] = useState<Tab>('overview');

  const [ports, setPorts] = useState<PortItem[]>([]);
  const [demoPort, setDemoPort] = useState<PortItem>({ path: 'demo', label: 'Демо-режим (без платы)' });
  const [selected, setSelected] = useState('');
  const [appState, setAppState] = useState<AppState | null>(null);
  const [busy, setBusy] = useState(false);
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
  const refreshPorts = useCallback(async () => {
    try {
      const r = await api<PortsResponse>('/api/ports');
      setPorts(r.ports);
      setDemoPort(r.demo);
      setSelected((cur) => cur || r.ports[0]?.path || r.demo.path);
    } catch (e: any) {
      setNotice({ kind: 'err', text: e.message });
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

  // ----- подключение -----
  const connect = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api<ConnectResponse>('/api/connect', {
        method: 'POST',
        body: JSON.stringify({ path: selected }),
      }, 20_000);
      setNotice({
        kind: 'ok',
        text: r.demo
          ? 'Демо-режим: данные эмулятора, плата не нужна.'
          : `Подключено: ${r.deviceName || 'BMS'}, ячеек: ${r.cellCount}.`,
      });
      setPollError('');
      await refreshState();
    } catch (e: any) {
      setNotice({ kind: 'err', text: e.message });
      await refreshState();
    } finally {
      setBusy(false);
    }
  };

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

  // ----- опрос платы -----
  const connected = Boolean(appState?.connected);
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

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <span className="brandmark"><img src="logo.png" alt="" /></span>
          <span className="brandtext">
            <b>JBD <em>BMS</em></b>
            <small>ЧТЕНИЕ И ПРОШИВКА · UART</small>
          </span>
        </div>

        <div className="tb-group port-group">
          <select
            className="port-select"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy || connected}
            aria-label="Порт"
          >
            {ports.length === 0 && <option value="">Порты не найдены</option>}
            {ports.map((p) => <option key={p.path} value={p.path}>{p.label}</option>)}
            <option value={demoPort.path}>{demoPort.label}</option>
          </select>
          <button className="tb-btn" title="Обновить список портов" onClick={refreshPorts} disabled={busy || connected}>
            <Icon name="refresh" />
          </button>
          {connected ? (
            <button className="btn" onClick={disconnect} disabled={busy}>Отключить</button>
          ) : (
            <button className="btn primary" onClick={connect} disabled={busy || !selected}>
              {busy ? 'Подключаю…' : 'Подключить'}
            </button>
          )}
        </div>

        <div className="tb-group toolbar-exit">
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

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'on' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {notice && (
        <div className={`banner ${notice.kind}`} role="status">
          <span>{notice.text}</span>
          <button className="btn tiny" onClick={() => setNotice(null)}>Закрыть</button>
        </div>
      )}

      <main className="content">
        {tab === 'overview' && <Overview snap={snap} connected={connected} error={pollError} />}
        {tab === 'cells' && <Cells snap={snap} connected={connected} error={pollError} />}
        {tab === 'settings' && <Settings connected={connected} />}
        {tab === 'firmware' && <Firmware connected={connected} snap={snap} onStateChange={refreshState} />}
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
