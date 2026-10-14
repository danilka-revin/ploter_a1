// Большая панель BMS: один экран, без прокрутки страницы.
//
//  • сверху — сводка по банкам в аккумуляторе (схема, мин/макс, разброс Δ, В, А, SOC, защиты);
//  • «Банки в аккумуляторе» — главный блок: сводка по ячейкам и карточка каждой банки #1…#N;
//  • «Графики» — все графики в едином визуальном стиле с акцентом на банки аккумулятора;
//  • «Отчёт по всем банкам» и «Порты и подключение» — работа с одной или несколькими платами;
//  • справа — «Плата: все данные и настройки» (сводка, пороги защит и прошивка без сырых регистров);
//  • снизу — «Управление» (ключи заряда/разряда, балансировка, ёмкость, сбросы и резервные копии);
//  • журнал событий — в нижней строке, открывается по клику.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useCockpit } from './store';
import { Tile, Btn, Chip, num } from './views/Tile';
import { BankTable, C, CellsTile, Charts, ConnectTile, KpiStrip } from './views/Report';
import { ControlTile, Journal } from './views/Ops';
import { DataTile } from './views/Editor';
import { UpdateDialog } from './views/UpdateDialog';
import { Icon } from './icons';
import type { Health, UpdateSnapshot } from './types';

const THEME_KEY = 'jbd.theme';
const DENSITY_KEY = 'jbd.density';
const UPDATE_FIRST_MS = 4_000;
const UPDATE_EVERY_MS = 30 * 60_000;
const FLEET = '__fleet__';

function read(key: string, dflt: string) {
  try { return globalThis.localStorage?.getItem(key) ?? dflt; } catch { return dflt; }
}

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (read(THEME_KEY, 'dark') === 'light' ? 'light' : 'dark'));
  const [density, setDensity] = useState<'compact' | 'roomy'>(() => (read(DENSITY_KEY, 'compact') === 'roomy' ? 'roomy' : 'compact'));
  const [journalOpen, setJournalOpen] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [update, setUpdate] = useState<UpdateSnapshot | null>(null);
  const [updOpen, setUpdOpen] = useState(false);
  const [pickedCell, setPickedCell] = useState<number | null>(null);

  const cockpit = useCockpit();
  const { panel, catalog, focus, focusBank, series, registers } = cockpit;
  const banks = panel?.banks ?? [];
  const fleet = panel?.fleet;
  const isFleet = focus === FLEET || (!focus && banks.length > 1);
  const activeBank = focusBank ?? banks[0] ?? null;

  useEffect(() => {
    setPickedCell(null);
  }, [activeBank?.id]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { globalThis.localStorage?.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
    try { globalThis.localStorage?.setItem(DENSITY_KEY, density); } catch { /* ignore */ }
  }, [density]);

  useEffect(() => { api<Health>('/healthz').then(setHealth).catch(() => {}); }, []);

  const checkUpdate = useCallback(async () => {
    try { setUpdate(await api<UpdateSnapshot>('/update/check', {}, 20_000)); } catch { /* сервер не отвечает */ }
  }, []);
  useEffect(() => {
    const first = setTimeout(checkUpdate, UPDATE_FIRST_MS);
    const every = setInterval(checkUpdate, UPDATE_EVERY_MS);
    return () => { clearTimeout(first); clearInterval(every); };
  }, [checkUpdate]);
  const runUpdate = useCallback(async () => {
    try {
      setHealth(await api<Health>('/healthz'));
      setUpdate(await api<UpdateSnapshot>('/update/run', { method: 'POST' }));
    } catch (e: any) { cockpit.note('err', e.message || 'Не удалось запустить обновление'); }
  }, [cockpit.note]);
  useEffect(() => {
    if (!update || (update.phase !== 'running' && !update.running)) return;
    const id = setInterval(async () => {
      try {
        const next = await api<UpdateSnapshot>('/update/status');
        // В фоновой вкладке можно пропустить состояние done: сравниваем сам процесс.
        if (next.instanceId && update.instanceId && next.instanceId !== update.instanceId) {
          location.reload(); return;
        }
        setUpdate(next);
      } catch { /* идёт перезапуск сервера */ }
    }, 1000);
    return () => clearInterval(id);
  }, [update?.phase, update?.running]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!update?.restartRequired) return;
    let stop = false;
    const previousInstance = health?.instanceId;
    let wentDown = false;
    const wait = async () => {
      for (let i = 0; i < 60 && !stop; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const h = await api<Health>('/healthz', {}, 1500);
          if (!stop && h.ok && ((h.instanceId && h.instanceId !== previousInstance) || (!h.instanceId && wentDown))) {
            location.reload(); return;
          }
        } catch { wentDown = true; }
      }
      if (!stop) setUpdate((s) => s ? { ...s, phase: 'error', restartRequired: false,
        message: 'Обновление установлено, но новый сервер не ответил. Проверьте журнал и запустите программу заново.' } : s);
    };
    wait();
    return () => { stop = true; };
  }, [update?.restartRequired]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- горячие клавиши -----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /input|select|textarea/i.test(el.tagName)) return;
      if (e.key === 'Escape') { setJournalOpen(false); setPickedCell(null); return; }
      const k = e.key.toLowerCase();
      if (k === 'f' || e.key === 'F11') {
        e.preventDefault();
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else document.documentElement.requestFullscreen?.().catch(() => {});
      } else if ((e.ctrlKey || e.metaKey) && k === 'p') {
        e.preventDefault();
        const id = (isFleet || !activeBank) ? 'all' : activeBank.id;
        cockpit.printSummary(id);
      } else if (k === 'd') cockpit.addDemo();
      else if (k === 's') cockpit.findAndConnectAll();
      else if (k === 'j') setJournalOpen((v) => !v);
      else if (/^[1-9]$/.test(e.key)) {
        const bank = banks[Number(e.key) - 1];
        if (bank) cockpit.setFocus(bank.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [banks, cockpit, isFleet, activeBank]);

  const faultLabels = useMemo(() => Object.fromEntries((catalog?.faults ?? []).map((f) => [f.key, f.label])), [catalog]);
  const alertCount = (fleet?.faults ?? 0) + banks.filter((b) => !b.connected).length;
  const lastMsg = cockpit.log[0];
  const cellDelta = activeBank?.stats?.delta ?? fleet?.cellDelta ?? null;

  return (
    <div className="dash" data-alert={alertCount > 0 ? '1' : '0'}>
      <header className="bar" data-area="bar">
        <div className="brand" title="JBD / Xiaoxiang BMS · UART 9600 8N1">
          <img src="logo.png" alt="" />
          <b>JBD <em>BMS</em> <span>CELLS</span></b>
        </div>

        <div className="bar-kpis">
          <span className="bk"><i>банок в акуме</i><b>{activeBank?.cellCount ? `${activeBank.cellCount}S` : (fleet ? `${fleet.online}/${fleet.banks}` : '0')}</b></span>
          <span className="bk"><i>мин · макс банок</i><b>{activeBank?.stats ? `${(activeBank.stats.min / 1000).toFixed(3)}·${(activeBank.stats.max / 1000).toFixed(3)} В` : '—'}</b></span>
          <span className="bk"><i>разброс Δ</i><b className={(cellDelta ?? 0) > 30 ? 'warn' : ''}>{cellDelta ?? '—'} мВ</b></span>
          <span className="bk"><i>аккумулятор</i><b>{num(activeBank?.voltage ?? fleet?.voltageAvg ?? null, 2)} В · {num(activeBank?.current ?? fleet?.currentSum ?? null, 1)} А</b></span>
          <span className="bk"><i>заряд · мощн.</i><b>{num(activeBank?.soc ?? fleet?.socAvg ?? null, 0)}% · {num(activeBank?.power ?? fleet?.powerSum ?? null, 0)} Вт</b></span>
          <span className="bk"><i>T макс</i><b>{num(fleet?.tempMax ?? null, 1)} °C</b></span>
          <span className={`bk ${alertCount ? 'bad' : 'ok'}`}><i>защиты</i><b>{fleet?.faults ?? 0}</b></span>
        </div>

        <div className="bar-tools">
          <span className="seg" title="окно графиков">
            {cockpit.WINDOW_OPTIONS.map((sec: number) => (
              <button key={sec} className={cockpit.windowSec === sec ? 'on' : ''} onClick={() => cockpit.setWindowSec(sec)}>{Math.round(sec / 60)}м</button>
            ))}
          </span>
          <span className="seg" title="период опроса плат">
            {[500, 1000, 2000, 5000].map((ms) => (
              <button key={ms} className={cockpit.pollMs === ms ? 'on' : ''} onClick={() => cockpit.setRate(ms)} title={`опрос каждые ${ms} мс`}>{ms < 1000 ? `0,${Math.round(ms / 100)}с` : `${ms / 1000}с`}</button>
            ))}
          </span>
          <Btn small onClick={cockpit.exportCsv} title="Отчёт по всем банкам в CSV">CSV отчёт</Btn>
          <Btn small onClick={cockpit.exportJson} title="Полный отчёт в JSON">JSON</Btn>
          <Btn small
            onClick={() => cockpit.printSummary(cockpit.focusBank?.id ? cockpit.focusBank.id : 'all')}
            title="Распечатать сводку по аккумулятору на TTL-чековом принтере — чек на английском. Вид чека (короткий, средний, полный) выбирается в блоке принтера (Ctrl+P)"
          >🖶 Печать</Btn>
          <button className="ic" onClick={() => setDensity(density === 'compact' ? 'roomy' : 'compact')} title="Плотность панели">{density === 'compact' ? '⤡' : '⤢'}</button>
          <button className="ic" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Тема">{theme === 'dark' ? '☀' : '☾'}</button>
          <button className="ic" onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})} title="Полный экран (F)">⛶</button>
          <button className={`ic upd ${update?.updateAvailable ? 'new' : ''}`} onClick={() => setUpdOpen(true)} title="Обновления с GitHub"><Icon name="download" size={14} /></button>
        </div>
      </header>

      <Tile
        title="Банки в аккумуляторе" area="cel"
        hint={activeBank
          ? `${activeBank.label} · ${activeBank.cellCount || activeBank.cells.length} банок · клик по банке выделяет её на графике`
          : 'подключите плату или включите демо'}
        tools={
          <span className="chips">
            {pickedCell !== null && (
              <Chip on onClick={() => setPickedCell(null)} title="Сбросить выбор банки">
                банка #{pickedCell + 1} ✕
              </Chip>
            )}
            {banks.map((b) => (
              <Chip key={b.id} on={activeBank?.id === b.id} onClick={() => cockpit.setFocus(b.id)} title={`${b.path} · ${b.deviceName}`}>
                <i className="dot" style={{ background: b.connected ? C.soc : C.bad }} />{b.label}
              </Chip>
            ))}
          </span>
        }
      >
        <CellsTile
          bank={activeBank}
          registers={registers}
          pickedCell={pickedCell}
          onPickCell={setPickedCell}
        />
      </Tile>

      <Tile
        title="Отчёт по всем банкам" area="rep"
        hint={banks.length ? `${banks.length} плат(ы) · клик — выбрать · двойной клик — переименовать` : 'нет подключённых плат'}
        tools={<Btn small onClick={() => cockpit.refresh(focus)} title="Обновить данные сейчас">↻</Btn>}
      >
        <BankTable
          banks={banks} focus={focus}
          faultLabels={faultLabels}
          onFocus={(id) => cockpit.setFocus(id === focus ? FLEET : id)}
          onRename={cockpit.renameBank}
          onReconnect={cockpit.reconnectBank}
          onRemove={cockpit.removeBank}
        />
      </Tile>

      <Tile
        title="Графики" area="cht"
        hint={`единый стиль · окно ${Math.round(cockpit.windowSec / 60)} мин · курсор по графику показывает значения`}
        tools={
          <span className="chips">
            <Chip on={isFleet} onClick={() => cockpit.setFocus(FLEET)} title="сводка по всему парку">весь парк</Chip>
            {banks.map((b) => (
              <Chip key={b.id} on={focus === b.id && !isFleet} onClick={() => cockpit.setFocus(b.id)} title={`${b.path} · ${b.deviceName}`}>
                <i className="dot" style={{ background: b.connected ? C.soc : C.bad }} />{b.label}
              </Chip>
            ))}
          </span>
        }
      >
        <KpiStrip panel={panel} bank={isFleet ? null : focusBank} series={series} isFleet={isFleet || !focusBank} />
        <Charts
          series={series}
          bank={activeBank}
          catalog={catalog}
          registers={registers}
          pickedCell={pickedCell}
          onPickCell={setPickedCell}
        />
      </Tile>

      <Tile
        title="Плата: все данные и настройки" area="dat"
        hint={focusBank ? `${focusBank.label}${focusBank.cellCount ? ` · ${focusBank.cellCount}S` : ''}` : 'банк не выбран'}
      >
        <DataTile
          registers={registers} catalog={catalog} busy={cockpit.busy}
          bankName={focusBank?.label ?? ''}
          onRead={() => cockpit.readRegisters(focusBank?.id ?? null)}
          onWrite={cockpit.writeSettings}
        />
      </Tile>

      <Tile title="Управление" area="ctl" hint="все команды требуют подтверждения вторым нажатием">
        <ControlTile
          bank={focusBank} busy={cockpit.busy} control={cockpit.control} catalog={catalog}
          onBackup={cockpit.backup} onRestore={cockpit.restore} panel={panel}
        />
      </Tile>

      <Tile title="Порты и подключение" area="cnc" hint="USB–UART 9600 8N1 · TTL-принтер чеков 5–9В">
        <ConnectTile
          ports={cockpit.ports} selected={cockpit.selected} onSelect={cockpit.setSelected}
          onConnect={() => cockpit.addBank(cockpit.selected)}
          onFind={cockpit.findAndConnectAll}
          onDemo={cockpit.addDemo}
          busy={cockpit.busy} scanning={cockpit.scanning}
          banks={banks} focus={focus}
          printerConfig={cockpit.printerConfig} printerTest={cockpit.printerTest} printSummary={cockpit.printSummary}
          note={cockpit.note}
          catalog={catalog}
        />
      </Tile>

      <footer className="bar foot" data-area="foot" onClick={() => setJournalOpen(true)} role="button" tabIndex={0}>
        <span className={`pulse-dot ${banks.some((b) => b.connected) ? 'on' : ''}`} />
        <span>{banks.length ? `опрос ${Math.round(cockpit.pollMs / 1000 * 10) / 10} с · обновлено ${panel?.at ? new Date(panel.at).toLocaleTimeString('ru-RU') : '—'}` : 'плат нет · «Демо-банки» или «Найти и подключить все»'}</span>
        {cockpit.error ? <span className="err-line">{cockpit.error}</span> : lastMsg ? <span className="muted">{new Date(lastMsg.at).toLocaleTimeString('ru-RU')} · {lastMsg.text}</span> : null}
        <span className="sp" />
        {update?.updateAvailable && <button className="linkish" onClick={(e) => { e.stopPropagation(); setUpdOpen(true); }}>есть обновление</button>}
        <span className="muted">журнал (J) · F — полный экран · 1…9 — акум</span>
        <span className="muted">v{health?.app ?? '—'}{health?.commit ? ` · ${health.commit}` : ''}</span>
      </footer>

      {journalOpen && (
        <div className="veil" onClick={() => setJournalOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Журнал панели</h3>
            <Journal log={cockpit.log} error={cockpit.error} />
            <div className="modal-actions"><Btn onClick={() => setJournalOpen(false)}>Закрыть</Btn></div>
          </div>
        </div>
      )}

      {updOpen && (
        <UpdateDialog
          update={update} onClose={() => setUpdOpen(false)} onCheck={checkUpdate} onRun={() => { runUpdate(); setUpdOpen(false); }}
        />
      )}
    </div>
  );
}
