// Ячейки: напряжение каждой ячейки, разброс (дельта) и подсветка min/max.
import type { Snapshot } from '../types';
import { Empty } from './Overview';

// Шкала LiFePO4: 2.5 В … 3.65 В. Столбцы показывают положение внутри неё.
const LO = 2500;
const HI = 3650;
const DELTA_WARN_MV = 30;

export function Cells({ snap, connected, error }: { snap: Snapshot | null; connected: boolean; error: string }) {
  if (!connected) return <Empty title="Плата не подключена">Подключите BMS на вкладке «Обзор».</Empty>;
  if (!snap) return <Empty title="Читаю ячейки…">{error ? `Ошибка: ${error}` : 'Запрос к BMS…'}</Empty>;

  const cells = snap.cells.values;
  const st = snap.cells.stats;
  const balancing = new Set(snap.basic.balancingCells);
  const deltaWarn = st ? st.delta > DELTA_WARN_MV : false;

  return (
    <div className="grid cells">
      <section className="card wide">
        <div className="cells-head">
          <div>
            <div className="label">Разброс напряжений</div>
            <div className={`big sm ${deltaWarn ? 'warn' : ''}`}>{st ? `${st.delta} мВ` : '—'}</div>
          </div>
          <div className="stats">
            <Stat label="Минимум" value={st ? `${st.min} мВ (ячейка ${st.minIndex + 1})` : '—'} />
            <Stat label="Максимум" value={st ? `${st.max} мВ (ячейка ${st.maxIndex + 1})` : '—'} />
            <Stat label="Среднее" value={st ? `${st.avg} мВ` : '—'} />
            <Stat label="Сумма" value={`${(cells.reduce((a, b) => a + b, 0) / 1000).toFixed(3)} В`} />
          </div>
        </div>
        {deltaWarn && (
          <p className="muted small">
            Разброс больше {DELTA_WARN_MV} мВ. Проверьте балансировку и контакты ячеек.
          </p>
        )}
      </section>

      <section className="card wide">
        {cells.length === 0 && <p className="muted">Плата не вернула данных по ячейкам.</p>}
        <ul className="bars">
          {cells.map((v, i) => {
            const pct = Math.max(0, Math.min(100, ((v - LO) / (HI - LO)) * 100));
            const isMin = st?.minIndex === i;
            const isMax = st?.maxIndex === i;
            return (
              <li key={i} className={`bar-row ${isMin ? 'is-min' : ''} ${isMax ? 'is-max' : ''}`}>
                <span className="bar-n">Ячейка {i + 1}</span>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
                <span className="bar-v">{(v / 1000).toFixed(3)} В</span>
                <span className="bar-tag">{balancing.has(i + 1) ? 'баланс' : ''}</span>
              </li>
            );
          })}
        </ul>
        <p className="muted small">Шкала 2.50–3.65 В (LiFePO4). Минимальная ячейка — жёлтым, максимальная — золотым.</p>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="stat"><div className="label">{label}</div><div>{value}</div></div>;
}
