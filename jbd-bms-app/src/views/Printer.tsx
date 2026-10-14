// Плитка «Чековый принтер»: выбор UART-порта TTL-принтера, скорости,
// кнопка «тестовая страница», предпросмотр чека и главная кнопка «Распечатать сводку».
// Чек на английском, только печатные ASCII-символы.
// Мусор вместо текста (включая цифры и латиницу) — это несовпадение скорости
// UART: «Найти скорость (авто)» перебирает скорости и форматы кадра и оставляет
// ту, на которой принтер отвечает; «Печатать на всех скоростях» печатает блоки
// для проверки по бумаге, если провод TX принтера не подключён.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Btn, Chip } from './Tile';
import type {
  BankRow, PortItem, PrinterDetectResult, PrinterPreview, PrinterQueryResult, PrinterStatus, PrinterSweepResult,
} from '../types';

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
  const [framing, setFraming] = useState('8N1');
  const [width, setWidth] = useState(32);
  const [pending, setPending] = useState(false);
  // какая длинная операция идёт: поиск скорости, перебор печатью или запрос состояния
  const [diagBusy, setDiagBusy] = useState<string | null>(null);
  const locked = busy != null || pending || diagBusy != null;
  const [allBanks, setAllBanks] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<PrinterPreview | null>(null);
  const [detect, setDetect] = useState<PrinterDetectResult | null>(null);
  const [diag, setDiag] = useState<{ kind: 'ok' | 'err' | 'info'; text: string; extra?: string[] } | null>(null);

  const refresh = async () => {
    try {
      const s = await api<PrinterStatus>('/api/printer');
      setStatus(s);
      setPath(s.path);
      setBaudRate(s.baudRate);
      setFraming(s.framing ?? '8N1');
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
    setPending(true);
    try {
      const s = await onConfig(patch);
      if (s) { setStatus(s); setPath(s.path); setBaudRate(s.baudRate); setFraming(s.framing ?? '8N1'); setWidth(s.width); }
      if (s && preview) loadPreview(preview.kind === 'test' ? 'test' : undefined);
    } finally { setPending(false); }
  };

  const diagnostic = async () => {
    setPending(true);
    try {
      await api('/api/printer/diagnostic', { method: 'POST' }, 15_000);
      note('info', 'Тест отправлен. На бумаге должно быть Hello 123 ABC abc. Нечитаемо — нажмите «Найти скорость (авто)».');
      await refresh();
    } catch (e: any) { note('err', e.message); }
    finally { setPending(false); }
  };

  /** Спросить у принтера состояние: ответ доказывает, что скорость и TX в порядке. */
  const queryPrinter = async () => {
    setDiagBusy('query');
    try {
      const r = await api<PrinterQueryResult>('/api/printer/query', { method: 'POST' }, 30_000);
      setDiag({ kind: r.ok ? 'ok' : 'info', text: r.message });
      note(r.ok ? 'ok' : 'info', r.message);
      await refresh();
    } catch (e: any) { setDiag({ kind: 'err', text: e.message }); note('err', e.message); }
    finally { setDiagBusy(null); }
  };

  /** Автопоиск скорости: принтер отвечает только на «своей» скорости UART. */
  const findBaud = async () => {
    if (!path) { note('err', 'Сначала выберите порт принтера.'); return; }
    setDiagBusy('detect');
    setDetect(null);
    try {
      const r = await api<PrinterDetectResult>('/api/printer/detect', { method: 'POST' }, 180_000);
      setDetect(r);
      setDiag({
        kind: r.found ? 'ok' : 'info',
        text: r.message,
        extra: r.hits.map((h) => `${h.baudRate} ${h.framing} · ответ ${h.hex} (${h.query})${h.confirmed ? '' : ' · без подтверждения'}`),
      });
      if (r.found) { setBaudRate(r.baudRate); setFraming(r.framing); }
      note(r.found ? 'ok' : 'info', r.message);
      await refresh();
    } catch (e: any) { setDiag({ kind: 'err', text: e.message }); note('err', e.message); }
    finally { setDiagBusy(null); }
  };

  /** Перебор скоростей печатью: на бумаге ищем читаемый блок (нужно, если нет TX принтера). */
  const sweepBauds = async () => {
    if (!path) { note('err', 'Сначала выберите порт принтера.'); return; }
    setDiagBusy('sweep');
    try {
      const r = await api<PrinterSweepResult>('/api/printer/sweep', { method: 'POST' }, 300_000);
      setDiag({ kind: 'info', text: r.message, extra: r.printed.map((b) => `${b} ${r.framing}`) });
      note('info', 'Блоки напечатаны — найдите на бумаге читаемый.');
      await refresh();
    } catch (e: any) { setDiag({ kind: 'err', text: e.message }); note('err', e.message); }
    finally { setDiagBusy(null); }
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
        <span className="muted tiny" title="Скорость, формат кадра и протокол должны совпадать с моделью принтера">
          {baudRate} {framing} · чек на английском
        </span>
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
          onChange={(e) => applyCfg({ path: e.target.value })}
          disabled={locked}
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
          disabled={!configured || locked || !banks.length}
          title={`Распечатать чек (на английском) со сводкой по ${allBanks ? 'всему парку' : (selectedBank?.label ?? 'аккумулятору')}`}
        >
          🖶 {busy === 'printer' ? 'Печать…' : `Печать сводки${allBanks ? ' (все)' : ''}`}
        </button>
      </div>

      <div className="printer-row">
        <span className="muted tiny">на бумаге мусор вместо текста?</span>
        <Btn small tone="primary" onClick={findBaud} disabled={!configured || locked} title="Перебрать 9600/19200/38400/57600/115200 и 8N1/8E1/7E1: принтер отвечает только на своей скорости">
          {diagBusy === 'detect' ? 'Ищу скорость…' : 'Найти скорость (авто)'}
        </Btn>
        <button type="button" className="linkish small" onClick={sweepBauds} disabled={!configured || locked} title="Напечатать короткие блоки на всех скоростях — читаемый блок покажет скорость принтера">
          {diagBusy === 'sweep' ? 'печатаю блоки…' : 'печатать на всех скоростях'}
        </button>
        <button type="button" className="linkish small" onClick={queryPrinter} disabled={!configured || locked} title="Спросить у принтера состояние: ответ доказывает, что скорость и TX принтера в порядке">
          {diagBusy === 'query' ? 'спрашиваю…' : 'состояние принтера'}
        </button>
      </div>

      {diag && (
        <div className={`banner ${diag.kind === 'ok' ? 'ok' : diag.kind === 'err' ? 'err' : 'info'} small`}>
          {diag.text}
          {diag.extra?.length ? <ul className="diag-list">{diag.extra.map((x) => <li key={x}>{x}</li>)}</ul> : null}
        </div>
      )}

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
              <span>протокол</span>
              <select value={status?.profile ?? 'plain'} onChange={(e) => applyCfg({ profile: e.target.value })} disabled={locked}>
                <option value="plain">Простой текст (без команд)</option>
                <option value="escpos">ESC/POS (без команд нагрева)</option>
                <option value="alexgyver">AlexGyver / TTL (команды нагрева)</option>
              </select>
            </label>
            <label className="printer-field">
              <span>пауза после строки</span>
              <select value={status?.lineDelayMs ?? 800} onChange={(e) => applyCfg({ lineDelayMs: Number(e.target.value) })} disabled={locked}>
                {[0, 100, 300, 800, 1500, 2000].map((ms) => <option key={ms} value={ms}>{ms} мс</option>)}
              </select>
            </label>
          </div>
          <div className="printer-row">
            <label className="printer-field">
              <span>скорость UART</span>
              <select value={baudRate} onChange={(e) => applyCfg({ baudRate: Number(e.target.value) })} disabled={locked}>
                {(status?.bauds ?? [9600, 19200, 38400, 57600, 115200, 4800, 2400]).map((b) => (
                  <option key={b} value={b}>{b} бод</option>
                ))}
              </select>
            </label>
            <label className="printer-field">
              <span>кадр</span>
              <select value={framing} onChange={(e) => applyCfg({ framing: e.target.value })} disabled={locked} title="8N1 — у большинства модулей; 8E1 и 7E1 — у части китайских">
                {(status?.framings ?? ['8N1', '8E1', '7E1']).map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <label className="printer-field">
              <span>ширина</span>
              <select value={width} onChange={(e) => applyCfg({ width: Number(e.target.value) })} disabled={locked}>
                {[24, 32, 36, 42, 48].map((w) => <option key={w} value={w}>{w} симв.</option>)}
              </select>
            </label>
          </div>
          <div className="printer-row">
            <Btn small onClick={diagnostic} disabled={!configured || locked} title="Короткий ASCII-тест без ESC-команд на выбранной скорости">
              Тест Hello 123 (без команд)
            </Btn>
            <Btn small onClick={doTest} disabled={!configured || locked} title="Напечатать пробную страницу для проверки подключения">
              {busy === 'printer-test' ? 'Печать…' : 'Пробная страница'}
            </Btn>
            <button type="button" className="linkish small" onClick={() => loadPreview('test')} title="Показать пробную страницу на экране">как она выглядит</button>
            <span className="muted tiny">TTL UART · 5–9В питание (VH) · {framing} · чек на английском (ASCII)</span>
          </div>
          {status?.lastError && <div className="banner err small">{status.lastError}</div>}
          {detect && !detect.found && (
            <div className="banner info small">
              Проверено комбинаций: {detect.tried}. Ни одна не ответила — {detect.message}
            </div>
          )}
          <p className="muted tiny">
            <b>Если на бумаге мусор вместо букв и цифр</b> — это не текст и не кодировка, а линия: принтер читает
            байты на другой скорости. Нажмите <b>«Найти скорость (авто)»</b>: приложение переберёт 9600/19200/38400/
            57600/115200 и форматы кадра 8N1/8E1/7E1 и оставит ту комбинацию, на которой принтер отвечает
            (команды состояния не печатаются, бумага почти не тратится). Провод TX принтера → RX адаптера
            нужен только для этого автоответа. Если он не подключён, нажмите <b>«печатать на всех скоростях»</b> —
            на бумаге будет несколько блоков, читаемый блок и есть скорость вашего принтера (например, 19200
            вместо 9600). Потом нажмите «Пробная страница».
          </p>
          <p className="muted tiny">
            Если читаемого текста нет ни на одной скорости, ни на одном формате кадра — скорость тут не при чём.
            Проверьте: общий GND, TX→RX (их часто путают: TX адаптера → RX принтера, RX адаптера → TX принтера),
            уровень и тип интерфейса — модули бывают TTL и RS-232 (±5 В), для RS-232 нужен преобразователь
            MAX3232/SP3232. Тип бумаги и питание 5–9 В (VH) тоже влияют: слабое питание даёт бледные или
            «рваные» строки, но не мусор.
          </p>
          <p className="muted tiny">
            Подключение: GND принтера к GND адаптера, TX принтера к RX адаптера, RX принтера к TX адаптера.
            Принтер подключается на отдельный USB-UART адаптер параллельно BMS; скорость и формат кадра
            сохраняются в printer.json и переживают перезапуск.
          </p>
        </div>
      )}
    </div>
  );
}
