// Блок 1: порт и подключение. Кнопка «Найти батарею» сама опрашивает все порты,
// поэтому пользователю не нужно знать, какой COM-порт или /dev/ttyUSB* занят BMS.
import type { PortItem, ScanResponse, ScanResult } from '../types';
import { Icon } from '../icons';
import { PortHelp } from './PortHelp';

export function ConnectionCard({
  ports, demoPort, selected, onSelect, onRefresh,
  connected, busy, scanning, scan, portName, demo, deviceName,
  onConnect, onDisconnect, onFind, onConnectPath,
}: {
  ports: PortItem[];
  demoPort: PortItem;
  selected: string;
  onSelect: (path: string) => void;
  onRefresh: () => void;
  connected: boolean;
  busy: boolean;
  scanning: boolean;
  scan: ScanResponse | null;
  portName: string | null;
  demo: boolean;
  deviceName: string;
  onConnect: () => void;
  onDisconnect: () => void;
  onFind: () => void;
  onConnectPath: (path: string) => void;
}) {
  const selectedLabel = [...ports, demoPort].find((p) => p.path === selected)?.label ?? '';

  return (
    <section className="card port-card" aria-labelledby="conn-title">
      <div className="sec-head">
        <h2 id="conn-title">1. Подключение к батарее</h2>
        <StatusLine connected={connected} demo={demo} portName={portName} deviceName={deviceName} />
      </div>

      <div className="port-row">
        <label className="visually-hidden" htmlFor="port-select">Порт</label>
        <select
          id="port-select"
          className="port-select big"
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
          disabled={busy || connected || scanning}
        >
          {ports.length === 0 && <option value="">Адаптер не найден — вставьте USB-UART</option>}
          {ports.map((p) => <option key={p.path} value={p.path}>{p.label}</option>)}
          <option value={demoPort.path}>{demoPort.label}</option>
        </select>
        <button className="big-btn ghost" onClick={onRefresh} disabled={busy || connected || scanning} title="Обновить список портов">
          <Icon name="refresh" size={18} /> Обновить список
        </button>
      </div>

      {!connected && selectedLabel && selected !== demoPort.path && (
        <p className="muted small port-note">Выбрано: <b>{selectedLabel}</b>. Список обновляется сам, когда вставляете адаптер.</p>
      )}

      <div className="port-actions">
        {connected ? (
          <button className="big-btn danger" onClick={onDisconnect} disabled={busy}>Отключить батарею</button>
        ) : (
          <button className="big-btn primary" onClick={onConnect} disabled={busy || scanning || !selected}>
            {busy ? 'Подключаю…' : 'Подключить'}
          </button>
        )}
        <button className="big-btn" onClick={onFind} disabled={connected || busy || scanning}>
          <Icon name="search" size={20} />
          {scanning ? 'Ищу батарею…' : 'Найти батарею'}
        </button>
      </div>

      {scan && <ScanList scan={scan} connected={connected} busy={busy} onConnect={onConnectPath} />}

      <details className="port-help">
        <summary>Как понять, к какому порту подключена батарея</summary>
        <PortHelp />
      </details>
    </section>
  );
}

function StatusLine({ connected, demo, portName, deviceName }: {
  connected: boolean; demo: boolean; portName: string | null; deviceName: string;
}) {
  if (!connected) return <span className="pill off"><span className="dot-off" /> Не подключено</span>;
  return (
    <span className="pill on">
      <span className="pulse" />
      {demo ? 'Демо-режим (без платы)' : `Подключено: ${portName}`}
      {deviceName && !demo ? ` · ${deviceName}` : ''}
    </span>
  );
}

function ScanList({ scan, connected, busy, onConnect }: {
  scan: ScanResponse; connected: boolean; busy: boolean; onConnect: (path: string) => void;
}) {
  const none = scan.found.length === 0;
  return (
    <div className={`scan ${none ? 'scan-none' : 'scan-found'}`} role="status">
      <div className="scan-title">
        {none
          ? (scan.results.length === 0 ? 'Адаптеры USB–UART не найдены.' : 'Батарея не найдена ни на одном порту.')
          : `Найдено батарей: ${scan.found.length}`}
      </div>
      {scan.results.length > 0 && (
        <ul className="scan-list">
          {scan.results.map((r) => (
            <li key={r.path} className={r.found ? 'ok' : 'bad'}>
              <span className="scan-ico"><Icon name={r.found ? 'check' : 'alert'} size={16} /></span>
              <span className="scan-main">
                <b>{r.path}</b>
                <span className="muted small"> · {r.label}</span>
                <span className="scan-res">{scanText(r)}</span>
              </span>
              {r.found && (
                <button className="big-btn small" onClick={() => onConnect(r.path)} disabled={connected || busy}>
                  Подключить
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {none && scan.results.length > 0 && (
        <p className="small muted">
          Проверьте, что адаптер вставлен и его TX/RX/GND подключены к плате BMS, а батарея включена. Подробнее — в инструкции ниже.
        </p>
      )}
    </div>
  );
}

function scanText(r: ScanResult): string {
  if (r.found) return `батарея отвечает: ${r.cellCount} ячеек${r.deviceName ? `, ${r.deviceName}` : ''}`;
  if (r.reason === 'busy') return 'порт занят или нет доступа — закройте другие программы';
  return 'порт открылся, но плата не отвечает (не BMS или нет питания платы)';
}
