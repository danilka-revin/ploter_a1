// Плитка «Чековый принтер»: выбор UART-порта TTL-принтера, скорости,
// кнопка «тестовая страница», предпросмотр чека и главная кнопка «Распечатать сводку».
// Сам чек печатается на английском языке и только символами ASCII — так его
// правильно печатает любой ESC/POS-принтер (без иероглифов и «кракозябр»).
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Btn, Chip } from './Tile';
import type { BankRow, PortItem, PrinterPreview, PrinterStatus } from '../types';

export function PrinterTile({
  ports, banks, focus, busy, onConfig, onTest, onPrint, note,
}: {
  ports: (PortItem & { used?: boolean })[];
  banks: BankRow[];
  focus: string | null;
  busy: string | null;
  onConfig: (patch: Record<string, unknown>) => Promise<PrinterStatus | null>;
  onTest: () => Promise<void>;
  onPrint: (id: string) => Promise<void>;
  note: (kind: 'ok' | 'err' | 'info', text: string) => void;
}) {
  const [status, setStatus] = useState<PrinterStatus | null>(null);
  const [path, setPath] = useState('');
  const [baudRate, setBaudRate] = useState(9600);
  const [width, setWidth] = useState(32);
  const [allBanks, setAllBanks] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<PrinterPreview | null>(null);

  const refresh = async () => {
    try {
      const s = await api<PrinterStatus>('/api/printer');
      setStatus(s);
      setPath(s.path);
      setBaudRate(s.baudRate);
      setWidth(s.width);
    } catch (e: any) {
      note('err', e.message ?? 'Не удалось прочитать статус принтера');
    }
  };

  useEffect(() => { refresh(); }, []); // eslint-disable-line

  const printTarget = () => (allBanks ? 'all' : (focus && banks.find((b) => b.id === focus)?.id) || banks[0]?.id || '');

  /** Предпросмотр: сводка по выбранному аккумулятору (или парку), без банков — пробная страница. */
  const loadPreview = async (target = printTarget() || 'test') => {
    try {
      setPreview(await api<PrinterPreview>(`/api/printer/preview?id=${encodeURIComponent(target)}`));
    } catch (e: any) {
      note('err', e.message ?? 'Не удалось показать чек');
    }
  };

  // открытый предпросмотр следует за выбором аккумулятора / «все банки»
  useEffect(() => {
    if (preview && preview.kind !== 'test') loadPreview();
  }, [allBanks, focus]); // eslint-disable-line

  const applyCfg = async (patch: Record<string, unknown>) => {
    const s = await onConfig(patch);
    if (s) { setStatus(s); setPath(s.path); setBaudRate(s.baudRate); setWidth(s.width); }
    if (s && preview) loadPreview(preview.kind === 'test' ? 'test' : undefined);
  };

  const onPathBlur = () => {
    if (path === (status?.path ?? '')) return;
    applyCfg({ path });
  };
  const onBaudBlur = () => {
    if (baudRate === (status?.baudRate ?? 9600)) return;
    applyCfg({ baudRate });
  };

  const doTest = async () => {
    if (!path) { note('err', 'Сначала выберите порт принтера.'); return; }
    await onTest();
    refresh();
  };

  const doPrint = async () => {
    if (!path) { note('err', 'Сначала выберите порт принтера.'); return; }
    const target = printTarget();
    if (!target) { note('err', 'Нет подключённых аккумуляторов для печати.'); return; }
    await onPrint(target);
    refresh();
  };

  const selectedBank = (focus && banks.find((b) => b.id === focus)) || banks[0] || null;
  const configured = Boolean(path);
  // порт принтера занят платой: опрос BMS каждую секунду печатает кадры dd a5 03 … вместо чека
  const portBusy = Boolean(status?.busy);
  const stateText = !status?.configured ? 'не настроен' : portBusy ? 'порт занят платой' : (status?.open ? 'подключён' : 'порт выбран');

  return (
    <div className="printer-tile">
      <div className="printer-row">
        <span className="printer-state" title={status?.lastError || ''}>
          <i className="dot" style={{ background: portBusy ? 'var(--danger)' : (!status?.configured ? 'var(--warn)' : (status?.open ? 'var(--ok)' : 'var(--text-2)')) }} />
          принтер: {stateText}
        </span>
        <span className="muted tiny" title="Чек печатается на английском только символами ASCII — их понимает любой принтер">чек на английском</span>
        <button type="button" className="linkish small" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'свернуть ▴' : 'настроить ▾'}
        </button>
      </div>

      {portBusy && (
        <div className="banner err small">
          Порт {status?.path} занят платой: опрос BMS печатается на принтере вместо чека.{' '}
          <button type="button" className="linkish small" onClick={() => applyCfg({ path })}>
            освободить порт принтера
          </button>
        </div>
      )}

      <div className="printer-main">
        <select
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onBlur={onPathBlur}
          disabled={busy != null && !busy.startsWith('printer')}
          title="UART-порт TTL-принтера (5–9 В питание, RX/TX/GND)"
        >
          <option value="">— выберите порт принтера —</option>
          {path && !ports.some((p) => p.path === path) && <option value={path}>{path}</option>}
          {ports.map((p) => (
            <option key={p.path} value={p.path}>
              {p.path}{p.used ? ' · занят банком' : ''}{p.printer && !p.used ? ' · принтер' : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="b primary print-btn"
          onClick={doPrint}
          disabled={!configured || busy != null || !banks.length}
          title={`Распечатать чек (на английском) со сводкой по ${allBanks ? 'всему парку' : (selectedBank?.label ?? 'аккумулятору')}`}
        >
          🖶 {busy === 'printer' ? 'Печать…' : `Печать сводки${allBanks ? ' (все)' : ''}`}
        </button>
      </div>

      <div className="printer-row">
        <Chip on={allBanks} onClick={() => setAllBanks(!allBanks)} title="Распечатать сводку по всем подключённым платам одним чеком">
          {allBanks ? `все банки (${banks.length})` : 'выбранный акум'}
        </Chip>
        {selectedBank && !allBanks && (
          <span className="muted small">
            {selectedBank.label} · {selectedBank.cellCount || selectedBank.cells.length}S · {selectedBank.soc ?? '—'}% · {selectedBank.voltage ? `${selectedBank.voltage.toFixed(1).replace('.',',')}В` : '—'}
          </span>
        )}
        {!selectedBank && !allBanks && <span className="muted small">аккумулятор не выбран</span>}
        <button
          type="button"
          className="linkish small"
          onClick={() => (preview ? setPreview(null) : loadPreview())}
          title="Показать на экране, что будет напечатано (бумага не расходуется)"
        >
          {preview ? 'скрыть чек' : 'предпросмотр чека'}
        </button>
      </div>

      {preview && (
        <div className="printer-preview">
          <div className="printer-row">
            <span className="muted tiny">
              так чек ляжет на бумагу · {preview.width} симв. в строке · английский, ASCII
            </span>
            <button type="button" className="linkish small" onClick={() => loadPreview(preview.kind === 'test' ? 'test' : undefined)}>обновить</button>
          </div>
          <pre className="receipt" style={{ width: `calc(${preview.width}ch + 18px)` }}>{preview.lines.join('\n')}</pre>
        </div>
      )}

      {expanded && (
        <div className="printer-cfg">
          <div className="printer-row">
            <label className="printer-field">
              <span>скорость UART</span>
              <select value={baudRate} onChange={(e) => setBaudRate(Number(e.target.value))} onBlur={onBaudBlur} disabled={busy != null}>
                {(status?.bauds ?? [9600, 19200, 38400, 57600, 115200]).map((b) => (
                  <option key={b} value={b}>{b} бод</option>
                ))}
              </select>
            </label>
            <label className="printer-field">
              <span>ширина</span>
              <select value={width} onChange={(e) => applyCfg({ width: Number(e.target.value) })} disabled={busy != null}>
                {[24, 32, 36, 42, 48].map((w) => <option key={w} value={w}>{w} симв.</option>)}
              </select>
            </label>
          </div>
          <div className="printer-row">
            <Btn small onClick={doTest} disabled={!configured || busy != null} title="Напечатать пробную страницу для проверки подключения">
              {busy === 'printer-test' ? 'Печать…' : 'Пробная страница'}
            </Btn>
            <button type="button" className="linkish small" onClick={() => loadPreview('test')} title="Показать пробную страницу на экране">как она выглядит</button>
            <span className="muted tiny">TTL UART · 5–9В питание (VH) · 8N1 · чек на английском (ASCII)</span>
          </div>
          {status?.lastError && <div className="banner err small">{status.lastError}</div>}
          <p className="muted tiny">
            Чек печатается на английском языке только латиницей и цифрами (ASCII): такие символы одинаково
            печатает любой чековый принтер, кодовую страницу и кириллицу настраивать не нужно.
            Если на бумаге всё равно непонятные символы — даже вместо цифр, — не совпадает скорость:
            попробуйте 19200 или 115200 (скорость своей модели видно на самотесте — включите принтер
            с зажатой кнопкой FEED). Строки переносятся не там — подберите ширину по линейке на пробной странице.
            Порт принтера программа не опрашивает как плату и не подключает его кнопкой «Найти и подключить все»:
            иначе кадры опроса BMS (dd a5 03 00 ff fd 77) печатались бы иероглифами.
          </p>
          <p className="muted tiny">
            Подключение: GND принтера к GND адаптера, TX принтера к RX адаптера, RX принтера к TX адаптера.
            Уровень логики у большинства дешёвых TTL-принтеров — 5 В. Принтер подключается на отдельный
            USB-UART адаптер параллельно BMS.
          </p>
        </div>
      )}
    </div>
  );
}
