// Банки в аккумуляторе + отчёт + подключение + ключевые показатели + единые графики.
import { useMemo, useState } from 'react';
import { Spark, Trend, Gauge, CellBars } from '../charts';
import { Btn, Chip, num } from './Tile';
import { PrinterTile } from './Printer';
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

/**
 * Главная плитка «Банки в аккумуляторе»:
 * наглядная сводка по банкам (мин, среднее, макс, разброс Δ, сумма, балансировка)
 * и карточка каждой банки #1…#N с напряжением в В и мВ, отклонением от среднего,
 * индикатором уровня и выбором банки для подсветки на графике.
 */
export function CellsTile({
  bank, registers, pickedCell = null, onPickCell,
}: {
  bank: BankRow | null;
  registers?: any;
  pickedCell?: number | null;
  onPickCell?: (idx: number | null) => void;
}) {
  const limits = useMemo(() => {
    const items: any[] = registers?.settings ?? [];
    const get = (key: string) => {
      const v = Number(items.find((i) => i.key === key)?.value);
      return Number.isFinite(v) ? v : null;
    };
    return {
      cuvp: get('cuvp') ?? 2500,
      covp: get('covp') ?? 3650,
      balStart: get('bal_start') ?? 3400,
      balWindow: get('bal_window') ?? 15,
    };
  }, [registers]);

  const cells = bank?.cells ?? [];
  const stats = bank?.stats ?? null;
  if (!bank || !cells.length || !stats) {
    return (
      <div className="blank">
        <b>Нет данных по банкам в аккумуляторе</b>
        <p>Подключите плату BMS по USB–UART или нажмите «Демо-банки», чтобы видеть напряжение, разброс и балансировку каждой банки в аккумуляторе.</p>
      </div>
    );
  }

  const balSet = new Set(bank.balancingCells ?? []);
  const sumV = ((stats.sum ?? cells.reduce((a, b) => a + b, 0)) / 1000).toFixed(2).replace('.', ',');
  const deltaTone = stats.delta > 50 ? 'bad' : stats.delta > 25 ? 'warn' : 'ok';
  const deltaText = stats.delta > 50 ? 'разбаланс' : stats.delta > 25 ? 'внимание' : 'в норме';
  const loMv = limits.cuvp;
  const hiMv = limits.covp;

  return (
    <div className="cells-focus">
      <div className="cells-summary">
        <div className="cs-item">
          <span className="cs-k">Схема акума</span>
          <b className="cs-v">{cells.length}S <i>· {cells.length} банок</i></b>
        </div>
        <div className={`cs-item ${deltaTone}`}>
          <span className="cs-k">Разброс банок Δ</span>
          <b className="cs-v">{stats.delta} <i>мВ · {deltaText}</i></b>
        </div>
        <div className="cs-item min">
          <span className="cs-k">Мин. банка #{stats.minIndex + 1}</span>
          <b className="cs-v">{(stats.min / 1000).toFixed(3).replace('.', ',')} <i>В ({stats.min} мВ)</i></b>
        </div>
        <div className="cs-item">
          <span className="cs-k">Средняя банка</span>
          <b className="cs-v">{(stats.avg / 1000).toFixed(3).replace('.', ',')} <i>В ({stats.avg} мВ)</i></b>
        </div>
        <div className="cs-item max">
          <span className="cs-k">Макс. банка #{stats.maxIndex + 1}</span>
          <b className="cs-v">{(stats.max / 1000).toFixed(3).replace('.', ',')} <i>В ({stats.max} мВ)</i></b>
        </div>
        <div className="cs-item">
          <span className="cs-k">Сумма банок</span>
          <b className="cs-v">{sumV} <i>В</i></b>
        </div>
        <div className={`cs-item ${balSet.size ? 'ok' : ''}`}>
          <span className="cs-k">Балансировка</span>
          <b className="cs-v">
            {balSet.size ? bank.balancingCells.map((n) => `#${n}`).join(', ') : 'покой'}
            <i>{balSet.size ? ` · ${balSet.size} шт.` : ` · порог ${(limits.balStart / 1000).toFixed(2).replace('.', ',')} В`}</i>
          </b>
        </div>
      </div>

      <div className="cells-grid">
        {cells.map((mv, i) => {
          const idx = i + 1;
          const dev = Math.round(mv - stats.avg);
          const isMin = stats.minIndex === i;
          const isMax = stats.maxIndex === i;
          const isBal = balSet.has(idx);
          const isPick = pickedCell === i;
          const pct = Math.max(0, Math.min(100, ((mv - loMv) / (hiMv - loMv || 1)) * 100));
          const devStr = dev > 0 ? `+${dev} мВ` : `${dev} мВ`;
          return (
            <button
              type="button"
              key={idx}
              className={`cell-card${isBal ? ' is-bal' : ''}${isMin ? ' is-min' : ''}${isMax ? ' is-max' : ''}${isPick ? ' is-pick' : ''}${Math.abs(dev) >= 25 ? ' is-warn' : ''}`}
              onClick={() => onPickCell?.(isPick ? null : i)}
              title={`Банка #${idx}: ${(mv / 1000).toFixed(3)} В (${mv} мВ), отклонение от среднего ${devStr}`}
            >
              <div className="cc-top">
                <span className="cc-idx">Банка #{idx}</span>
                <span className="cc-badges">
                  {isBal && <em className="cc-badge bal">БАЛ</em>}
                  {isMin && <em className="cc-badge min">МИН</em>}
                  {isMax && <em className="cc-badge max">МАКС</em>}
                </span>
              </div>
              <div className="cc-main">
                <b className="cc-v">{(mv / 1000).toFixed(3).replace('.', ',')} <i>В</i></b>
                <span className={`cc-dev ${dev <= -10 ? 'neg' : dev >= 10 ? 'pos' : ''}`}>{devStr}</span>
              </div>
              <div className="cc-bar">
                <i style={{ width: `${pct.toFixed(1)}%` }} />
              </div>
              <div className="cc-foot">
                <span>{mv} мВ</span>
                <span>{Math.round(pct)}%</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

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
          <th>Акум</th><th className="c">банок</th><th className="n">Δ мВ</th><th className="n">мин·макс В</th>
          <th className="n">В</th><th className="n">А</th><th className="n">Вт</th>
          <th className="n">SOC</th><th>График SOC</th><th className="n">Ач</th>
          <th className="n">T °C</th><th className="c">ключи</th><th>защиты</th><th className="n">цикл</th>
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
              <td className="c mono">{b.cellCount ? `${b.cellCount}S` : '—'}</td>
              <td className={`n mono ${b.stats && b.stats.delta > 30 ? 'warn' : ''}`}>{b.stats?.delta ?? '—'}</td>
              <td className="n mono small">{b.stats ? `${(b.stats.min / 1000).toFixed(3)}·${(b.stats.max / 1000).toFixed(3)}` : '—'}</td>
              <td className="n mono">{num(b.voltage, 2)}</td>
              <td className={`n mono ${b.current == null ? '' : b.current < -0.05 ? 'neg' : b.current > 0.05 ? 'pos' : ''}`}>{b.current == null ? '—' : `${b.current > 0 ? '+' : ''}${num(b.current, 2)}`}</td>
              <td className="n mono">{num(b.power, 0)}</td>
              <td className="n">
                <span className="socmini"><i style={{ width: `${Math.max(0, Math.min(100, soc ?? 0))}%` }} /></span>
                <b className="mono">{soc == null ? '—' : `${Math.round(soc)}%`}</b>
              </td>
              <td><Spark values={(b.spark ?? []).map((s) => s.soc)} color={C.soc} /></td>
              <td className="n mono">{num(b.remainingAh, 1)}</td>
              <td className="n mono small">{b.temperatures.length ? b.temperatures.map((t) => num(t, 1)).join(' ') : '—'}</td>
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

/** Полоса ключевых чисел: акцент на банки и состояние аккумулятора. */
const EMPTY_FLEET: Fleet = {
  banks: 0, online: 0, stale: 0, voltageAvg: null, currentSum: null, powerSum: null, powerMax: null, socAvg: null,
  ahSum: null, ahCapacity: null, cellMin: null, cellMax: null, cellDelta: null, tempMax: null, faults: 0, balancing: 0,
  cyclesMax: null, chargeFetOff: 0, dischargeFetOff: 0,
};

export function KpiStrip({ panel, bank, series, isFleet }: { panel: Panel | null; bank: BankRow | null; series: Series | null; isFleet: boolean }) {
  const f = panel?.fleet ?? EMPTY_FLEET;
  const minMv = isFleet ? f.cellMin : (bank?.stats?.min ?? null);
  const maxMv = isFleet ? f.cellMax : (bank?.stats?.max ?? null);
  const cells: { k: string; v: string; unit?: string; tone?: string; spark?: (number | null)[]; color?: string }[] = [
    { k: 'Разброс ячеек', v: isFleet ? String(f.cellDelta ?? '—') : String(bank?.stats?.delta ?? '—'), unit: 'мВ', tone: ((isFleet ? f.cellDelta : bank?.stats?.delta) ?? 0) > 30 ? 'warn' : 'ok', spark: series?.delta ?? undefined, color: C.delta },
    { k: 'Мин · макс банок', v: minMv != null && maxMv != null ? `${(minMv / 1000).toFixed(3)}·${(maxMv / 1000).toFixed(3)}` : '—', unit: 'В', spark: series?.min ?? undefined, color: C.volt },
    { k: 'Напряжение', v: isFleet ? num(f.voltageAvg, 2) : num(bank?.voltage ?? null, 2), unit: 'В', spark: series?.v ?? undefined, color: C.volt },
    { k: 'Ток', v: isFleet ? num(f.currentSum, 2) : num(bank?.current ?? null, 2), unit: 'А', tone: (isFleet ? f.currentSum : bank?.current)! < 0 ? 'neg' : 'pos', spark: series?.a ?? undefined, color: C.cur },
    { k: 'Мощность', v: isFleet ? num(f.powerSum, 0) : num(bank?.power ?? null, 0), unit: 'Вт', spark: series?.w ?? undefined, color: C.pow },
    { k: 'Ёмкость', v: isFleet ? num(f.ahSum, 1) : num(bank?.remainingAh ?? null, 1), unit: `из ${num(isFleet ? f.ahCapacity : bank?.fullAh ?? null, 0)} Ач`, spark: series?.rem ?? undefined, color: C.soc },
    { k: 'Максимум T', v: num(f.tempMax, 1), unit: '°C', tone: (f.tempMax ?? 0) > 45 ? 'warn' : '', spark: series?.temps?.[0] ?? undefined, color: C.temp },
    { k: 'Активных защит', v: String(f.faults), unit: isFleet ? `весь парк: ${f.online}/${f.banks}` : (bank?.balancingCells.length ? `баланс: #${bank.balancingCells.join(',')}` : 'банки в норме'), tone: f.faults ? 'bad' : 'ok' },
  ];
  return (
    <div className="kpis">
      {cells.map((c) => (
        <div key={c.k} className={`kpi ${c.tone ?? ''}`}>
          <span className="kpi-k">{c.k}</span>
          <span className="kpi-v">{c.v}{c.unit && <i> {c.unit}</i>}</span>
          {c.spark && <span className="kpi-spark"><Spark values={c.spark} color={c.color ?? C.volt} w={110} h={16} /></span>}
        </div>
      ))}
      <div className="kpi gauge-cell">
        <Gauge value={isFleet ? f.socAvg : (bank?.soc ?? null)} label={isFleet ? 'средний заряд парка' : 'остаток заряда'} sub={isFleet ? `${num(f.ahSum, 0)} Ач всего` : `${num(bank?.remainingAh ?? null, 1)} Ач`} />
      </div>
    </div>
  );
}

/**
 * Все графики панели выполнены в едином визуальном дизайне:
 * одинаковая шапка карточки с текущим показанием, единая координатная сетка,
 * плавные линии с мягкой заливкой, курсор с точками и общая нижняя легенда.
 * Первый ряд целиком посвящён банкам в аккумуляторе.
 */
export function Charts({
  series, bank, catalog: _catalog, registers, pickedCell = null, onPickCell,
}: {
  series: Series | null;
  bank: BankRow | null;
  catalog: Catalog | null;
  registers: any;
  pickedCell?: number | null;
  onPickCell?: (idx: number | null) => void;
}) {
  const t = series?.t ?? [];
  const limits = useMemo(() => {
    const items: any[] = registers?.settings ?? [];
    const get = (key: string) => {
      const v = Number(items.find((i) => i.key === key)?.value);
      return Number.isFinite(v) ? v : null;
    };
    return {
      covp: get('covp'),
      cuvp: get('cuvp'),
      balWindow: get('bal_window'),
      cellT: get('dsgot'),
      packV: get('povp'),
      packU: get('puvp'),
    };
  }, [registers]);

  if (!series || t.length < 2) {
    return (
      <div className="blank">
        <b>Графики появятся через минуту</b>
        <p>Панель строит ряды по истории опросов: уже есть выборок — {series?.samples ?? 0}. Увеличьте окно графика в шапке, если плата подключена недавно.</p>
      </div>
    );
  }

  const cellLo = bank?.cells.length ? Math.min(...bank.cells) : 0;
  const cellHi = bank?.cells.length ? Math.max(...bank.cells) : 0;
  const cellAvg = bank?.stats?.avg ?? (cellLo && cellHi ? Math.round((cellLo + cellHi) / 2) : 0);

  // Ряды напряжений банок (в вольтах) для первого графика
  const minVSeries = (series.min ?? []).map((v) => (v == null ? null : Number((v / 1000).toFixed(3))));
  const maxVSeries = (series.max ?? []).map((v) => (v == null ? null : Number((v / 1000).toFixed(3))));
  const avgVSeries = (series.avg && series.avg.length === t.length
    ? series.avg
    : t.map((_, i) => {
      const a = series.min?.[i];
      const b = series.max?.[i];
      return a != null && b != null ? Math.round((a + b) / 2) : null;
    })
  ).map((v) => (v == null ? null : Number((v / 1000).toFixed(3))));

  const pickedSeries = pickedCell != null && series.cells?.[pickedCell]
    ? series.cells[pickedCell].map((v) => (v == null ? null : Number((v / 1000).toFixed(3))))
    : null;

  return (
    <div className="charts">
      <div className="chart-box">
        <div className="chart-head">
          <h4><i className="ch-dot" style={{ background: C.volt }} />Банки в акуме · напряжение</h4>
          <span className="chart-now">
            {pickedCell != null && bank?.cells?.[pickedCell] != null
              ? `банка #${pickedCell + 1}: ${(bank.cells[pickedCell] / 1000).toFixed(3).replace('.', ',')} В`
              : cellAvg ? `ср. ${(cellAvg / 1000).toFixed(3).replace('.', ',')} В` : '—'}
          </span>
        </div>
        <Trend
          t={t}
          height={148}
          unit="В"
          decimals={3}
          lines={[
            ...(pickedSeries ? [{ name: `банка #${pickedCell! + 1}`, values: pickedSeries, color: C.soc, fill: true, unit: 'В', decimals: 3, width: 2.1 }] : []),
            { name: 'среднее', values: avgVSeries, color: C.volt, fill: !pickedSeries, unit: 'В', decimals: 3 },
            { name: 'макс', values: maxVSeries, color: C.cur, dashed: true, unit: 'В', decimals: 3, width: 1.4 },
            { name: 'мин', values: minVSeries, color: C.bad, dashed: true, unit: 'В', decimals: 3, width: 1.4 },
          ]}
        />
      </div>

      <div className="chart-box">
        <div className="chart-head">
          <h4><i className="ch-dot" style={{ background: C.delta }} />Разброс ячеек · остаток заряда</h4>
          <span className="chart-now">Δ {bank?.stats?.delta ?? series.delta?.at(-1) ?? '—'} мВ · {bank?.soc ?? series.soc?.at(-1) ?? '—'}%</span>
        </div>
        <Trend
          t={t}
          height={148}
          leftMin={0}
          thresholds={limits.balWindow ? [{ value: limits.balWindow, color: C.warn, label: `окно ${limits.balWindow} мВ` }] : []}
          lines={[
            { name: 'разброс', values: series.delta, color: C.delta, fill: true, unit: 'мВ', decimals: 0 },
            { name: 'заряд', values: series.soc, color: C.soc, axis: 'right', unit: '%', decimals: 0 },
          ]}
        />
      </div>

      <div className="chart-box">
        <div className="chart-head">
          <h4><i className="ch-dot" style={{ background: C.soc }} />Профиль банок {bank ? `· ${bank.label}` : ''}</h4>
          <span className="chart-now">мин {(cellLo / 1000).toFixed(3).replace('.', ',')} · макс {(cellHi / 1000).toFixed(3).replace('.', ',')} В</span>
        </div>
        {bank?.cells?.length ? (
          <CellBars
            values={bank.cells}
            stats={bank.stats as any}
            balancing={bank.balancingCells}
            lo={limits.cuvp ?? 2800}
            hi={limits.covp ?? 3700}
            height={148}
            picked={pickedCell}
            onPick={(i) => onPickCell?.(pickedCell === i ? null : i)}
          />
        ) : (
          <div className="chart chart-empty" style={{ height: 148 }}>
            <span>нет данных банок — аккумулятор не выбран</span>
          </div>
        )}
      </div>

      <div className="chart-box">
        <div className="chart-head">
          <h4><i className="ch-dot" style={{ background: C.volt }} />Напряжение · ток</h4>
          <span className="chart-now">{num(bank?.voltage ?? series.v?.at(-1) ?? null, 2)} В · {num(bank?.current ?? series.a?.at(-1) ?? null, 1)} А</span>
        </div>
        <Trend
          t={t}
          height={148}
          thresholds={limits.packV && limits.packU && bank?.cellCount ? [{ value: limits.packV / 1000, color: C.bad, label: 'порог OV' }, { value: limits.packU / 1000, color: C.warn, label: 'порог UV' }] : []}
          lines={[
            { name: 'напряжение', values: series.v, color: C.volt, fill: true, unit: 'В', decimals: 2 },
            { name: 'ток', values: series.a, color: C.cur, axis: 'right', dashed: true, unit: 'А', decimals: 1 },
          ]}
        />
      </div>

      <div className="chart-box">
        <div className="chart-head">
          <h4><i className="ch-dot" style={{ background: C.pow }} />Мощность · заряд и разряд</h4>
          <span className="chart-now">{num(bank?.power ?? series.w?.at(-1) ?? null, 0)} Вт</span>
        </div>
        <Trend
          t={t}
          height={148}
          unit="Вт"
          symmetricZero
          decimals={0}
          lines={[{ name: 'мощность', values: series.w, color: C.pow, fill: true, unit: 'Вт', decimals: 0 }]}
        />
      </div>

      <div className="chart-box">
        <div className="chart-head">
          <h4><i className="ch-dot" style={{ background: C.temp }} />Температуры плат и ячеек</h4>
          <span className="chart-now">{num(bank?.temperatures?.[0] ?? series.temps?.[0]?.at(-1) ?? null, 1)} °C</span>
        </div>
        <Trend
          t={t}
          height={148}
          unit="°C"
          decimals={1}
          thresholds={limits.cellT ? [{ value: limits.cellT, color: C.bad, label: `защита ${limits.cellT} °C` }] : []}
          lines={(series.temps ?? []).slice(0, 4).map((vals, i) => ({
            name: `датчик ${i + 1}`,
            values: vals,
            color: [C.temp, '#ffb27d', '#54c8f0', '#c58cff'][i % 4],
            fill: i === 0,
            unit: '°C',
            decimals: 1,
          })).filter((_, i) => (series.temps?.[i] ?? []).some((v) => v !== null && v !== undefined))}
        />
      </div>
    </div>
  );
}

/** Подключение: список портов, кнопки поиска и демо, список занятых портов. */
export function ConnectTile({
  ports, selected, onSelect, onConnect, onFind, onDemo, busy, scanning, banks, focus,
  printerConfig, printerTest, printSummary, note,
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
  focus: string | null;
  printerConfig: (patch: Record<string, unknown>) => Promise<any>;
  printerTest: () => Promise<void>;
  printSummary: (id: string) => Promise<void>;
  note: (kind: 'ok' | 'err' | 'info', text: string) => void;
  catalog?: Catalog | null;
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
        <Btn tone="primary" onClick={onConnect} disabled={busy === 'connect' || !selected} title="Подключить выбранный порт">
          {busy === 'connect' ? 'Открываю порт…' : '+ Подключить'}
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
            <b>{b.cellCount ? `${b.cellCount}S · ` : ''}{num(b.voltage, 1)} В</b>
          </span>
        ))}
        {!banks.length && <span className="muted small">пока пусто</span>}
      </div>

      <div className="printer-block">
        <PrinterTile
          ports={ports} banks={banks} focus={focus} busy={busy}
          onConfig={printerConfig} onTest={printerTest} onPrint={printSummary} note={note}
        />
      </div>
    </div>
  );
}

function plural(n: number) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'банк';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'банка';
  return 'банков';
}
