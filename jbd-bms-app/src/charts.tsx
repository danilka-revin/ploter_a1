// Единая система графиков панели: собственные SVG-компоненты в одном визуальном стиле.
//
//  • useSize  — следит за размером контейнера, чтобы координаты были в пикселях
//               (текст и линии не искажаются, как при preserveAspectRatio="none");
//  • Trend    — линейный график с мягкой заливкой, сеткой, осями, порогами, курсором и легендой;
//  • CellBars — график напряжений по банкам аккумулятора (#1…#N) в том же едином каркасе
//               (та же сетка, оси, пороги, курсор и легенда);
//  • Spark    — мини-график в том же стиле (линия + мягкая заливка);
//  • Gauge    — компактная шкала заряда.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export const AXIS_FONT = 9.5;

/** Размер элемента в пикселях (для SSR отдаёт запасной размер, чтобы тесты рендерились). */
export function useSize(fallback = { w: 480, h: 150 }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(fallback);
  const apply = useCallback(() => {
    const el = ref.current;
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      setSize((prev) => (Math.abs(prev.w - r.width) < 1 && Math.abs(prev.h - r.height) < 1 ? prev : { w: r.width, h: r.height }));
    }
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') return;
    apply();
    const ro = new ResizeObserver(apply);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [apply]);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [apply]);
  return { ref, ...size };
}

export interface Line {
  name: string;
  values: (number | null)[];
  color: string;
  fill?: boolean;
  dashed?: boolean;
  axis?: 'left' | 'right';
  width?: number;
  bars?: boolean;
  unit?: string;
  decimals?: number;
}

export interface Threshold { value: number; color: string; label?: string; axis?: 'left' | 'right' }

function extent(values: (number | null)[][], pad = 0.12): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const list of values) {
    for (const v of list) {
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min - 1, max + 1];
  const span = max - min;
  return [min - span * pad, max + span * pad];
}

function niceTicks(min: number, max: number, count = 4) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0) ?? mag * 10;
  const first = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = first; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

const fmtNum = (v: number, digits = 2) => {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const d = abs >= 100 ? Math.min(digits, 1) : abs >= 10 ? digits : Math.max(digits, 1);
  return v.toFixed(d).replace('.', ',');
};

export const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/**
 * Единый график временного ряда. Ось X — время (массив t), оси Y — значения серий.
 * Все графики панели используют единый стиль: сетка, оси, плавная линия с мягкой заливкой,
 * вертикальный курсор с точками и нижняя строка легенды.
 */
export function Trend({
  t, lines, height = 148, unit = '', leftMin = null, leftMax = null, rightMin = null, rightMax = null,
  thresholds = [], pad = 0.12, symmetricZero = false, decimals = 2, showGrid = true, legend = true,
}: {
  t: number[];
  lines: Line[];
  height?: number;
  unit?: string;
  leftMin?: number | null;
  leftMax?: number | null;
  rightMin?: number | null;
  rightMax?: number | null;
  thresholds?: Threshold[];
  pad?: number;
  symmetricZero?: boolean;
  decimals?: number;
  showGrid?: boolean;
  legend?: boolean;
}) {
  const { ref, w } = useSize({ w: 480, h: height });
  const [hover, setHover] = useState<number | null>(null);
  const padL = 42;
  const padR = lines.some((l) => l.axis === 'right') ? 38 : 10;
  const padT = 8;
  const padB = 18;
  const iw = Math.max(40, w - padL - padR);
  const ih = Math.max(30, height - padT - padB);
  const n = t.length;

  const leftLines = lines.filter((l) => l.axis !== 'right');
  const rightLines = lines.filter((l) => l.axis === 'right');
  const [lmin, lmax] = useMemo(() => {
    const e = extent([...leftLines.map((l) => l.values), ...thresholds.filter((x) => x.axis !== 'right').map((x) => [x.value])], pad);
    const a = leftMin ?? e[0];
    const b = leftMax ?? e[1];
    if (symmetricZero) {
      const m = Math.max(Math.abs(a), Math.abs(b)) || 1;
      return [-m, m];
    }
    return [a, b];
  }, [lines, thresholds, leftMin, leftMax, pad, symmetricZero]); // eslint-disable-line react-hooks/exhaustive-deps
  const [rmin, rmax] = useMemo(() => {
    const e = extent([...rightLines.map((l) => l.values), ...thresholds.filter((x) => x.axis === 'right').map((x) => [x.value])], pad);
    return [rightMin ?? e[0], rightMax ?? e[1]];
  }, [lines, thresholds, rightMin, rightMax, pad]); // eslint-disable-line react-hooks/exhaustive-deps

  if (n < 2 || !Number.isFinite(lmax) || lmax === lmin) {
    return (
      <div className="chart chart-empty" ref={ref} style={{ height }}>
        <span>{n ? 'мало данных для графика' : 'нет данных — подключите аккумулятор или включите демо'}</span>
      </div>
    );
  }

  const yL = (v: number) => padT + ih - ((v - lmin) / (lmax - lmin)) * ih;
  const yR = (v: number) => padT + ih - ((v - rmin) / (rmax - rmin || 1)) * ih;
  const x = (i: number) => padL + (i / (n - 1)) * iw;
  const ticks = niceTicks(lmin, lmax, 4);
  const rTicks = rightLines.length ? niceTicks(rmin, rmax, 3) : [];
  const baseY = symmetricZero ? yL(0) : padT + ih;

  const paths = lines.map((l, idx) => {
    const scale = l.axis === 'right' ? yR : yL;
    const segs: string[] = [];
    let open = false;
    let d = '';
    for (let i = 0; i < n; i++) {
      const v = l.values[i];
      if (v === null || v === undefined || !Number.isFinite(v)) { if (open) { segs.push(d); open = false; } continue; }
      d += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${scale(v).toFixed(1)}`;
      open = true;
    }
    if (open) segs.push(d);
    const shouldFill = l.fill ?? (idx === 0);
    const area = shouldFill && segs.length
      ? `${segs.join('')}L${x(lastIndex(l.values, n)).toFixed(1)},${baseY.toFixed(1)}L${x(firstIndex(l.values)).toFixed(1)},${baseY.toFixed(1)}Z`
      : '';
    return { line: segs.join(''), area, color: l.color, width: l.width ?? 1.8, dashed: l.dashed, values: l.values };
  });

  const hoverIdx = hover === null ? null : Math.max(0, Math.min(n - 1, hover));

  return (
    <div className="chart" ref={ref} style={{ height }}>
      <svg
        viewBox={`0 0 ${w} ${height}`} width={w} height={height}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          setHover(Math.round(((e.clientX - rect.left - padL) / iw) * (n - 1)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {showGrid && ticks.map((v) => (
          <g key={`g${v}`}>
            <line x1={padL} x2={padL + iw} y1={yL(v)} y2={yL(v)} className="ch-grid" />
            <text x={padL - 5} y={yL(v) + 3} textAnchor="end" className="ch-ax" style={{ fontSize: AXIS_FONT }}>{fmtNum(v, decimals)}</text>
          </g>
        ))}
        {rTicks.map((v) => (
          <text key={`r${v}`} x={padL + iw + 5} y={yR(v) + 3} className="ch-ax" style={{ fontSize: AXIS_FONT }}>{fmtNum(v, decimals)}</text>
        ))}
        <line x1={padL} x2={padL + iw} y1={padT + ih} y2={padT + ih} className="ch-axis" />
        {symmetricZero && <line x1={padL} x2={padL + iw} y1={yL(0)} y2={yL(0)} className="ch-zero" />}
        {thresholds.map((th, i) => {
          const y = (th.axis === 'right' ? yR : yL)(th.value);
          return (
            <g key={`th${i}`}>
              <line x1={padL} x2={padL + iw} y1={y} y2={y} stroke={th.color} className="ch-th" />
              {th.label && <text x={padL + 4} y={y - 3} className="ch-th-label" fill={th.color} style={{ fontSize: AXIS_FONT }}>{th.label}</text>}
            </g>
          );
        })}
        {paths.map((p, i) => (
          <g key={`p${i}`}>
            {p.area && <path d={p.area} fill={p.color} className="ch-area" />}
            <path d={p.line} fill="none" stroke={p.color} strokeWidth={p.width} strokeDasharray={p.dashed ? '4 4' : undefined} strokeLinecap="round" strokeLinejoin="round" />
          </g>
        ))}
        {hoverIdx !== null && (
          <g>
            <line x1={x(hoverIdx)} x2={x(hoverIdx)} y1={padT} y2={padT + ih} className="ch-cursor" />
            {paths.map((p, i) => {
              const v = p.values[hoverIdx];
              if (v === null || v === undefined || !Number.isFinite(v)) return null;
              const scale = lines[i].axis === 'right' ? yR : yL;
              return <circle key={`h${i}`} cx={x(hoverIdx)} cy={scale(v)} r={3} fill={p.color} className="ch-dot-pt" />;
            })}
          </g>
        )}
        <text x={padL} y={height - 4} className="ch-ax" style={{ fontSize: AXIS_FONT }}>{fmtTime(t[0])}</text>
        <text x={padL + iw} y={height - 4} textAnchor="end" className="ch-ax" style={{ fontSize: AXIS_FONT }}>{fmtTime(t[n - 1])}</text>
      </svg>
      {legend && (
        <div className="ch-legend">
          {lines.map((l) => {
            const u = l.unit ?? unit;
            const d = l.decimals ?? decimals;
            return (
              <span key={l.name} className="ch-key">
                <i style={{ background: l.color }} />{l.name}
                <b>{fmtNum(at(hoverIdx ?? n - 1, l.values), d)}{u ? ` ${u}` : ''}</b>
              </span>
            );
          })}
          {hoverIdx !== null && <span className="ch-time">{fmtTime(t[hoverIdx])}</span>}
        </div>
      )}
    </div>
  );
}

function at(i: number, values: (number | null)[]) {
  const v = values[i];
  return v === null || v === undefined ? NaN : v;
}
function firstIndex(values: (number | null)[]) {
  const i = values.findIndex((v) => v !== null && v !== undefined && Number.isFinite(v as number));
  return i < 0 ? 0 : i;
}
function lastIndex(values: (number | null)[], n: number) {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null && values[i] !== undefined) return i;
  return n - 1;
}

/** Мини-график в том же едином стиле (плавная линия + мягкая заливка). */
export function Spark({ values, w = 92, h = 22, color = 'var(--accent)', mode = 'line', zero = false }: {
  values: (number | null)[];
  w?: number;
  h?: number;
  color?: string;
  mode?: 'line' | 'bar';
  zero?: boolean;
}) {
  const clean = values.map((v) => (v === null || v === undefined || !Number.isFinite(v) ? null : (v as number)));
  if (clean.length < 2) return <span className="spark-empty">—</span>;
  const [min, max] = extent(clean.map((v) => [v]), 0.15);
  const y = (v: number) => h - 2 - ((v - min) / (max - min || 1)) * (h - 4);
  const x = (i: number) => (i / (clean.length - 1)) * (w - 4) + 2;
  let d = '';
  let open = false;
  clean.forEach((v, i) => {
    if (v === null) { open = false; return; }
    d += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    open = true;
  });
  const area = d ? `${d}L${x(lastIndex(clean, clean.length)).toFixed(1)},${(h - 1).toFixed(1)}L${x(firstIndex(clean)).toFixed(1)},${(h - 1).toFixed(1)}Z` : '';
  const bw = Math.max(1, (w - 2) / clean.length - 0.8);
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      {mode === 'bar' ? clean.map((v, i) => {
        if (v === null) return null;
        const base = zero ? y(Math.max(0, min)) : h - 1;
        const yy = y(v);
        return <rect key={i} x={x(i) - bw / 2} y={Math.min(base, yy)} width={bw} height={Math.max(0.6, Math.abs(yy - base))} fill={color} opacity={0.8} />;
      }) : (
        <g>
          {area && <path d={area} fill={color} className="ch-area" />}
          <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
    </svg>
  );
}

/**
 * Профиль напряжений банок аккумулятора (#1…#N) в том же едином дизайне, что и Trend:
 * координатная сетка, подписи оси Y (В), номера банок по оси X, линия среднего,
 * плавный контур с заливкой, столбики банок и единая легенда снизу.
 */
export function CellBars({ values, stats, balancing = [], lo = 2800, hi = 3700, height = 148, onPick, picked }: {
  values: number[];
  stats: { min: number; max: number; avg: number; minIndex: number; maxIndex: number } | null;
  balancing?: number[];
  lo?: number;
  hi?: number;
  height?: number;
  onPick?: (i: number) => void;
  picked?: number | null;
}) {
  const { ref, w } = useSize({ w: 480, h: height });
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length || 1;
  const min = stats?.min ?? Math.min(...values);
  const max = stats?.max ?? Math.max(...values);
  const avg = stats?.avg ?? Math.round((min + max) / 2);
  const span = Math.max(24, max - min);
  const loScale = Math.max(lo * 0.5, min - span * 0.35);
  const hiScale = Math.min(hi * 1.15, max + span * 0.35);

  const padL = 42;
  const padR = 10;
  const padT = 8;
  const padB = 18;
  const iw = Math.max(40, w - padL - padR);
  const ih = Math.max(30, height - padT - padB);
  const slotW = iw / n;
  const bw = Math.max(6, Math.min(24, slotW * 0.56));
  const cx = (i: number) => padL + slotW * (i + 0.5);
  const y = (mv: number) => padT + ih - ((mv - loScale) / (hiScale - loScale || 1)) * ih;
  const ticksV = niceTicks(loScale / 1000, hiScale / 1000, 3);
  const bal = new Set(balancing);

  const linePath = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${cx(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const areaPath = values.length > 1
    ? `${linePath}L${cx(n - 1).toFixed(1)},${(padT + ih).toFixed(1)}L${cx(0).toFixed(1)},${(padT + ih).toFixed(1)}Z`
    : '';
  const activeIdx = hover ?? (picked != null && picked >= 0 && picked < n ? picked : null);
  const activeMv = activeIdx !== null ? values[activeIdx] : null;
  const activeDev = activeMv !== null ? Math.round(activeMv - avg) : null;

  return (
    <div className="chart cellbars" ref={ref} style={{ height }}>
      <svg
        viewBox={`0 0 ${w} ${height}`} width={w} height={height}
        className="cellbars-svg"
        onMouseLeave={() => setHover(null)}
      >
        {ticksV.map((tv) => {
          const yy = y(tv * 1000);
          return (
            <g key={`cg${tv}`}>
              <line x1={padL} x2={padL + iw} y1={yy} y2={yy} className="ch-grid" />
              <text x={padL - 5} y={yy + 3} textAnchor="end" className="ch-ax" style={{ fontSize: AXIS_FONT }}>
                {tv.toFixed(3).replace('.', ',')}
              </text>
            </g>
          );
        })}
        <line x1={padL} x2={padL + iw} y1={padT + ih} y2={padT + ih} className="ch-axis" />
        <line x1={padL} x2={padL + iw} y1={y(avg)} y2={y(avg)} stroke="var(--accent)" className="ch-th cb-avg" />
        {areaPath && <path d={areaPath} fill="#ffc233" className="ch-area" />}
        {linePath && <path d={linePath} fill="none" stroke="#ffc233" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />}
        {values.map((v, i) => {
          const x0 = cx(i) - bw / 2;
          const isMin = stats?.minIndex === i;
          const isMax = stats?.maxIndex === i;
          const isBal = bal.has(i + 1);
          const isPick = picked === i || hover === i;
          const yy = y(v);
          const colColor = isBal ? '#7ddc52' : isMin ? '#e05548' : isMax ? '#54c8f0' : '#ffc233';
          return (
            <g
              key={i}
              className={`cb-col${isBal ? ' is-bal' : ''}${isMin ? ' is-min' : ''}${isMax ? ' is-max' : ''}${isPick ? ' is-pick' : ''}`}
              onMouseEnter={() => setHover(i)}
              onClick={onPick ? () => onPick(i) : undefined}
            >
              <rect x={x0} y={yy} width={bw} height={Math.max(2, padT + ih - yy)} rx={2} />
              <circle cx={cx(i)} cy={yy} r={isPick ? 3.2 : 2.2} fill={colColor} />
              {(n <= 16 || i % 2 === 0 || i === n - 1) && (
                <text x={cx(i)} y={height - 4} textAnchor="middle" className="ch-ax" style={{ fontSize: AXIS_FONT }}>
                  #{i + 1}
                </text>
              )}
              <rect x={padL + slotW * i} y={padT} width={slotW} height={ih} className="cb-hit" />
            </g>
          );
        })}
        {activeIdx !== null && (
          <line x1={cx(activeIdx)} x2={cx(activeIdx)} y1={padT} y2={padT + ih} className="ch-cursor" />
        )}
      </svg>
      <div className="ch-legend">
        <span className="ch-key">
          <i style={{ background: '#ffc233' }} />среднее
          <b>{(avg / 1000).toFixed(3).replace('.', ',')} В</b>
        </span>
        <span className="ch-key">
          <i style={{ background: '#e05548' }} />мин #{(stats?.minIndex ?? 0) + 1}
          <b>{(min / 1000).toFixed(3).replace('.', ',')} В</b>
        </span>
        <span className="ch-key">
          <i style={{ background: '#54c8f0' }} />макс #{(stats?.maxIndex ?? 0) + 1}
          <b>{(max / 1000).toFixed(3).replace('.', ',')} В</b>
        </span>
        {activeIdx !== null && activeMv !== null && (
          <span className="ch-time">
            банка #{activeIdx + 1}: {(activeMv / 1000).toFixed(3).replace('.', ',')} В ({activeDev && activeDev > 0 ? `+${activeDev}` : activeDev} мВ)
          </span>
        )}
      </div>
    </div>
  );
}

/** Шкала остатка заряда (дуга). */
export function Gauge({ value, label, sub = '', tone = '' }: { value: number | null; label: string; sub?: string; tone?: string }) {
  const v = value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value));
  const r = 26;
  const c = Math.PI * r;
  return (
    <div className={`gauge ${tone}`}>
      <svg viewBox="0 0 64 38" width="100%" height="46">
        <path d={`M6 32 A${r} ${r} 0 0 1 58 32`} className="g-track" />
        <path
          d={`M6 32 A${r} ${r} 0 0 1 58 32`} className="g-fill"
          strokeDasharray={`${(c * v) / 100} ${c}`}
        />
        <text x="32" y="29" textAnchor="middle" className="g-num">{Number.isFinite(value as number) ? Math.round(v) : '—'}%</text>
      </svg>
      <div className="g-label">{label}</div>
      {sub && <div className="g-sub">{sub}</div>}
    </div>
  );
}
