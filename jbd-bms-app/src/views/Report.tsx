// Отчёт по всем банкам + подключение + ключевые числа + графики.
import { useMemo, useState } from 'react';
import { Spark, Trend, Gauge, CellBars, fmtTime } from '../charts';
import { Btn, Chip, num } from './Tile';
import type { BankRow, Catalog, Fleet, Panel, PortItem, Series } from '../types';

export const C = {
  volt: '#ffc233',
  cur: '#54c8f0',
  pow: '#7ddc52',
  temp: '#ff8a5c',
  delta: '#c58cff',
  soc: '#4fd1a5',
  warn: '#e9c66e',
  bad: '#e05548',
};

/** Таблица-отчёт: одна строка на банк, главное сразу видно. */
export function BankTable({
  banks, focus, onFocus, onRename, onReconnect, onRemove, faultLabels,
}: {
  banks: BankRow[];
  focus: string | null;
  onFocus: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onReconnect: (id: string) => void;
  onRemove: (id: string) => void;
  faultLabels?: Record<string, string>;
}) {
  const [edit, setEdit] = useState<string | null>(null);
  const [text, setText] = useState('');
  if (!banks.length) {
    return (
      <div className="blank">
        <b>Банков пока нет</b>
        <p>Подключите USB–UART адаптер к плате BMS и нажмите «Найти и подключить все» — приложение опросит все порты и возьмёт в отчёт каждую отвечавшую плату. Без платы можно включить демо-банки.</p>
      </div>
    );
  }
  return (
    <table className="grid-table banks">
      <thead>
        <tr>
          <th>Банк</th><th className="n">В</th><th className="n">А</th><th className="n">Вт</th>
          <th className="n">SOC</th><th>График SOC</th><th className="n">Ач</th>
          <th className="n">Δ мВ</th><th className="n">мин·макс В</th><th className="n">T °C</th>
          <th className="c">яч</th><th className="c">ключи</th><th>защиты</th><th className="n">цикл</th>
          <th>плата</th><th className="a">·</th>
        </tr>
      </thead>
      <tbody>
        {banks.map((b) => {
          const on = b.id === focus;
          const soc = b.soc;
          return (
            <tr key={b.id} className={`${on ? 'is-focus' : ''} ${b.connected ? '' : 'is-off'}`} onClick={() => onFocus(b.id)}>
              <td>
                <span className={`st ${b.connected ? 'ok' : 'bad'}`} />
                {edit === b.id ? (
                  <input
                    className="rename" autoFocus value={text}
                    onChange={(e) => setText(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => { setEdit(null); if (text.trim()) onRename(b.id, text.trim()); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  />
                ) : (
                  <button className="linkish" title="Двойной клик — переименовать" onDoubleClick={(e) => { e.stopPropagation(); setEdit(b.id); setText(b.label); }} onClick={(e) => { e.stopPropagation(); onFocus(b.id); }}>
                    <b>{b.label}</b>
                  </button>
                )}
                <small>{b.path}{b.deviceName ? ` · ${b.deviceName}` : ''}</small>
              </td>
              <td className="n mono">{num(b.voltage, 2)}</td>
              <td className={`n mono ${b.current == null ? '' : b.current < -0.05 ? 'neg' : b.current > 0.05 ? 'pos' : ''}`}>{b.current == null ? '—' : `${b.current > 0 ? '+' : ''}${num(b.current, 2)}`}</td>
              <td className="n mono">{num(b.power, 0)}</td>
              <td className="n">
                <span className="socmini"><i style={{ width: `${Math.max(0, Math.min(100, soc ?? 0))}%` }} /></span>
                <b className="mono">{soc == null ? '—' : `${Math.round(soc)}%`}</b>
              </td>
              <td><Spark values={(b.spark ?? []).map((s) => s.soc)} color={C.soc} /></td>
              <td className="n mono">{num(b.remainingAh, 1)}</td>
              <td className={`n mono ${b.stats && b.stats.delta > 30 ? 'warn' : ''}`}>{b.stats?.delta ?? '—'}</td>
              <td className="n mono small">{b.stats ? `${(b.stats.min / 1000).toFixed(3)}·${(b.stats.max / 1000).toFixed(3)}` : '—'}</td>
              <td className="n mono small">{b.temperatures.length ? b.temperatures.map((t) => num(t, 1)).join(' ') : '—'}</td>
              <td className="c mono">{b.cellCount || '—'}</td>
              <td className="c">
                <span className={`fet ${b.chargeFetOn ? 'on' : 'off'}`} title="ключ заряда">З</span>
                <span className={`fet ${b.dischargeFetOn ? 'on' : 'off'}`} title="ключ разряда">Р</span>
              </td>
              <td className="small">
                {b.faults.length
                  ? <span className="faulties">{b.faults.map((f) => faultLabels?.[f.key] ?? f.label).join(', ')}</span>
                  : (b.connected ? <span className="muted">нет</span> : <span className="muted">{b.lastError ? 'нет связи' : '—'}</span>)}
              </td>
              <td className="n mono">{b.cycles ?? '—'}</td>
              <td className="small muted" title={`${b.hwVersion || ''} ${b.swVersion || ''}`}>{b.model || b.deviceName || '—'}</td>
              <td className="a">
                <button className="ic" title="Переподключить порт" onClick={(e) => { e.stopPropagation(); onReconnect(b.id); }}>⟳</button>
                <button className="ic" title="Отключить банк" onClick={(e) => { e.stopPropagation(); onRemove(b.id); }}>✕</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Полоса ключевых чисел: фокус на банке или сводка по парку. */
const EMPTY_FLEET: Fleet = {
  banks: 0, online: 0, stale: 0, voltageAvg: null, currentSum: null, powerSum: null, powerMax: null, socAvg: null,
  ahSum: null, ahCapacity: null, cellMin: null, cellMax: null, cellDelta: null, tempMax: null, faults: 0, balancing: 0,
  cyclesMax: null, chargeFetOff: 0, dischargeFetOff: 0,
};

export function KpiStrip({ panel, bank, series, isFleet }: { panel: Panel | null; bank: BankRow | null; series: Series | null; isFleet: boolean }) {
  const f = panel?.fleet ?? EMPTY_FLEET;
  const cells: { k: string; v: string; unit?: string; tone?: string; spark?: (number | null)[]; color?: string }[] = [
    { k: 'Напряжение', v: isFleet ? num(f.voltageAvg, 2) : num(bank?.voltage ?? null, 2), unit: 'В', spark: series?.v ?? undefined, color: C.volt },
    { k: 'Ток', v: isFleet ? num(f.currentSum, 2) : num(bank?.current ?? null, 2), unit: 'А', tone: (isFleet ? f.currentSum : bank?.current)! < 0 ? 'neg' : 'pos', spark: series?.a ?? undefined, color: C.cur },
    { k: 'Мощность', v: isFleet ? num(f.powerSum, 0) : num(bank?.power ?? null, 0), unit: 'Вт', spark: series?.w ?? undefined, color: C.pow },
    { k: 'Ёмкость', v: isFleet ? num(f.ahSum, 1) : num(bank?.remainingAh ?? null, 1), unit: `из ${num(isFleet ? f.ahCapacity : bank?.fullAh ?? null, 0)} Ач`, },
    { k: 'Разброс ячеек', v: isFleet ? String(f.cellDelta ?? '—') : String(bank?.stats?.delta ?? '—'), unit: 'мВ', tone: ((isFleet ? f.cellDelta : bank?.stats?.delta) ?? 0) > 30 ? 'warn' : '', spark: series?.delta ?? undefined, color: C.delta },
    { k: 'Максимум T', v: num(f.tempMax, 1), unit: '°C', tone: (f.tempMax ?? 0) > 45 ? 'warn' : '', spark: series?.temps?.[0] ?? undefined, color: C.temp },
    { k: 'Активных защит', v: String(f.faults), unit: f.balancing ? `балансируется ячеек: ${f.balancing}` : '', tone: f.faults ? 'bad' : 'ok' },
    { k: 'Банков', v: `${f.online}/${f.banks}`, unit: f.stale ? `нет связи: ${f.stale}` : 'все на связи', tone: f.stale ? 'warn' : 'ok' },
  ];
  return (
    <div className="kpis">
      {cells.map((c) => (
        <div key={c.k} className={`kpi ${c.tone ?? ''}`}>
          <span className="kpi-k">{c.k}</span>
          <span className="kpi-v">{c.v}{c.unit && <i> {c.unit}</i>}</span>
          {c.spark && <span className="kpi-spark"><Spark values={c.spark} color={c.color ?? C.volt} w={120} h={16} /></span>}
        </div>
      ))}
      <div className="kpi gauge-cell">
        <Gauge value={isFleet ? f.socAvg : (bank?.soc ?? null)} label={isFleet ? 'средний заряд парка' : 'остаток заряда'} sub={isFleet ? `${num(f.ahSum, 0)} Ач всего` : `${num(bank?.remainingAh ?? null, 1)} Ач`} />
      </div>
    </div>
  );
}

/** Четыре графика: В+А, Вт, температуры, Δ и SOC. */
export function Charts({ series, bank, catalog, registers }: { series: Series | null; bank: BankRow | null; catalog: Catalog | null; registers: any }) {
  const t = series?.t ?? [];
  const limits = useMemo(() => {
    const items: any[] = registers?.settings ?? [];
    const get = (key: string) => {
      const v = Number(items.find((i) => i.key === key)?.value);
      return Number.isFinite(v) ? v : null;
    };
    return { covp: get('covp'), cuvp: get('cuvp'), cellT: get('dsgot'), packV: get('povp'), packU: get('puvp') };
  }, [registers]);
  if (!series || t.length < 2) {
    return <div className="blank"><b>Графики появятся через минуту</b><p>Панель строит ряды по истории опросов: уже есть выборок — {series?.samples ?? 0}. Увеличьте окно графика в шапке, если плата подключена недавно.</p></div>;
  }
  const cellLo = bank?.cells.length ? Math.min(...bank.cells) : 0;
  const cellHi = bank?.cells.length ? Math.max(...bank.cells) : 0;
  return (
    <div className="charts">
      <div className="chart-box">
        <h4>Напряжение · ток</h4>
        <Trend t={t} height={148} thresholds={limits.packV && limits.packU && bank?.cellCount ? [{ value: limits.packV / 1000, color: C.bad, label: 'порог OV' }, { value: limits.packU / 1000, color: C.warn, label: 'порог UV' }] : []}
          lines={[
            { name: 'напряжение, В', values: series.v, color: C.volt, fill: true },
            { name: 'ток, А', values: series.a, color: C.cur, axis: 'right', dashed: true },
          ]} />
      </div>
      <div className="chart-box">
        <h4>Мощность · плюс заряд, минус разряд</h4>
        <Trend t={t} height={148} unit="Вт" symmetricZero decimals={0}
          lines={[{ name: 'мощность, Вт', values: series.w, color: C.pow, bars: true }]} />
      </div>
      <div className="chart-box">
        <h4>Температуры плат и ячеек</h4>
        <Trend t={t} height={148} unit="°C" decimals={0} thresholds={limits.cellT ? [{ value: limits.cellT, color: C.bad, label: `защита ${limits.cellT} °C` }] : []}
          lines={(series.temps ?? []).slice(0, 4).map((vals, i) => ({
            name: `датчик ${i + 1}`,
            values: vals,
            color: [C.temp, '#ffb27d', '#ff8f8f', '#ffd08a'][i % 4],
          })).filter((l, i) => (series.temps?.[i] ?? []).some((v) => v !== null && v !== undefined))} />
      </div>
      <div className="chart-box">
        <h4>Разброс ячеек · остаток заряда</h4>
        <Trend t={t} height={148} unit="%" leftMin={0}
          lines={[
            { name: 'разброс, мВ', values: series.delta, color: C.delta, fill: true },
            { name: 'заряд, %', values: series.soc, color: C.soc, axis: 'right' },
          ]} />
      </div>
      <div className="chart-box cell-summary">
        <h4>Ячейки {bank ? `· ${bank.label}` : ''} <span className="muted small">мин {(cellLo / 1000).toFixed(3)} · макс {(cellHi / 1000).toFixed(3)} В</span></h4>
        {bank?.cells?.length ? (
          <>
            <CellBars
              values={bank.cells}
              stats={bank.stats as any}
              balancing={bank.balancingCells}
              lo={limits.cuvp ?? 2800}
              hi={limits.covp ?? 3700}
            />
            <div className="cell-strip">
              {bank.cells.map((v, i) => (
                <span key={i} className={`${bank.balancingCells.includes(i + 1) ? 'bal' : ''} ${bank.stats && v === bank.stats.min ? 'min' : ''}`} title={`ячейка ${i + 1}`}>
                  {(v / 1000).toFixed(3)}
                </span>
              ))}
            </div>
          </>
        ) : <div className="blank"><p>Нет данных ячеек — банк не выбран или плата не отвечает.</p></div>}
      </div>
      <div className="chart-box history">
        <h4>Хронология опросов</h4>
        <ul className="hist">
          {(series.t ?? []).slice(-8).reverse().map((ts, i) => (
            <li key={ts}>
              <b>{fmtTime(ts)}</b>
              <span>{num(series.v?.[series.t.length - 1 - i], 2)} В</span>
              <span className={((series.a?.[series.t.length - 1 - i] ?? 0) < 0) ? 'neg' : 'pos'}>{num(series.a?.[series.t.length - 1 - i], 1)} А</span>
              <span className="muted">{series.soc?.[series.t.length - 1 - i] ?? '—'}%</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Подключение: список портов, кнопки поиска и демо, список занятых портов. */
export function ConnectTile({
  ports, selected, onSelect, onConnect, onFind, onDemo, busy, scanning, banks, catalog,
}: {
  ports: (PortItem & { used?: boolean })[];
  selected: string;
  onSelect: (p: string) => void;
  onConnect: () => void;
  onFind: () => void;
  onDemo: () => void;
  busy: string | null;
  scanning: boolean;
  banks: BankRow[];
  catalog: Catalog | null;
}) {
  const [showHelp, setShowHelp] = useState(false);
  return (
    <div className="connect">
      <div className="row">
        <select value={selected} onChange={(e) => onSelect(e.target.value)} disabled={scanning}>
          {!ports.some((p) => p.path === selected) && selected !== 'demo' && <option value={selected}>{selected}</option>}
          <option value="demo">Демо-режим (эмулятор платы)</option>
          {ports.map((p) => <option key={p.path} value={p.path}>{p.path}{p.used ? ' · занят банком' : ''}</option>)}
        </select>
        <Btn tone="primary" onClick={onConnect} disabled={busy === 'connect' || !selected} title="Подключить выбранный порт ещё одним банком">
          {busy === 'connect' ? 'Открываю порт…' : '+ Банк'}
        </Btn>
      </div>
      <div className="row">
        <Btn onClick={onFind} disabled={scanning} tone="ok" title="Опросить все свободные порты и подключить каждую найденную плату">
          {scanning ? 'Ищу платы на всех портах…' : 'Найти и подключить все'}
        </Btn>
        <Btn onClick={onDemo} disabled={busy === 'demo'} title="Четыре эмулятора платы: проверить панель без железа">
          {busy === 'demo' ? 'Запускаю демо…' : 'Демо-банки'}
        </Btn>
        <Chip onClick={() => setShowHelp(!showHelp)} on={showHelp} title="Как понять, какой порт нужен">порт?</Chip>
      </div>
      {showHelp && (
        <div className="help">
          <p><b>USB–UART → плата:</b> RX адаптера к TX платы, TX к RX, GND к GND. Скорость 9600 8N1, уровень логики обычно 3,3 В (5 В может повредить плату).</p>
          <p><b>Windows:</b> порт виден как COM3, COM4… — если его нет, поставьте драйвер CP210x / CH340 / FTDI.<br />
            <b>Ubuntu:</b> /dev/ttyUSB0… ; нужны права (группа dialout) и выключенный ModemManager:<br />
            <code>sudo systemctl disable --now ModemManager</code></p>
          <p className="muted">Порт не открывается? Его держит JBDTools или другая программа. Плата молчит? Проверьте TX/RX (их часто путают) и питание платы.{' '}
            <a href="/docs/kak-najti-port.md" target="_blank" rel="noreferrer">полная инструкция</a>
          </p>
        </div>
      )}
      <div className="bank-tags">
        <span className="muted small">в отчёте {banks.length} {plural(banks.length)}:</span>
        {banks.map((b) => (
          <span key={b.id} className={`tag ${b.connected ? 'on' : 'off'}`} title={`${b.path} · ${b.deviceName}`}>
            <i className={`st ${b.connected ? 'ok' : 'bad'}`} />{b.label}
            <b>{num(b.voltage, 1)} В</b>
          </span>
        ))}
        {!banks.length && <span className="muted small">пока пусто</span>}
      </div>
      {catalog && <p className="muted tiny">Каталог: {catalog.settings.length} регистров настроек, {catalog.regs.length} доступных регистров, {catalog.writable.length} можно менять.</p>}
    </div>
  );
}

function plural(n: number) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'банк';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'банка';
  return 'банков';
}
