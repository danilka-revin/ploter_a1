// Ячейки: компактная таблица по каждой ячейке — напряжение, отклонение от среднего,
// балансировка и положение внутри шкалы LiFePO4 (2,50–3,65 В).
import type { Snapshot } from '../types';
import { Empty } from './Overview';

const LO = 2500;
const HI = 3650;
const DELTA_WARN_MV = 30;

export function Cells({ snap, connected, error }: { snap: Snapshot | null; connected: boolean; error: string }) {
  if (!connected) return <Empty title="Плата не подключена">Подключите батарею в блоке «Подключение к батарее» (вверху страницы).</Empty>;
  if (!snap) return <Empty title="Читаю ячейки…">{error ? `Ошибка: ${error}` : 'Запрос к BMS…'}</Empty>;

  const cells = snap.cells.values;
  const st = snap.cells.stats;
  const balancing = new Set(snap.basic.balancingCells);
  const deltaWarn = st ? st.delta > DELTA_WARN_MV : false;
  const avg = st?.avg ?? 0;
  const sum = cells.reduce((a, b) => a + b, 0);

  return (
    <div className="grid cells">
      <section className="card wide">
        <div className="cells-summary small">
          <span>Ячеек: <b>{cells.length}</b></span>
          <span className={deltaWarn ? 'warn' : ''}>Разброс: <b>{st ? `${st.delta} мВ` : '—'}</b></span>
          <span>Мин: <b>{st ? `${(st.min / 1000).toFixed(3)} В (№${st.minIndex + 1})` : '—'}</b></span>
          <span>Макс: <b>{st ? `${(st.max / 1000).toFixed(3)} В (№${st.maxIndex + 1})` : '—'}</b></span>
          <span>Среднее: <b>{st ? `${(st.avg / 1000).toFixed(3)} В` : '—'}</b></span>
          <span>Сумма: <b>{(sum / 1000).toFixed(2)} В</b></span>
          <span>Баланс: <b>{balancing.size ? [...balancing].sort((a, b) => a - b).map((n) => `№${n}`).join(', ') : 'нет'}</b></span>
        </div>
        {deltaWarn && (
          <p className="muted small">Разброс больше {DELTA_WARN_MV} мВ. Проверьте балансировку и контакты ячеек.</p>
        )}

        {cells.length === 0 ? (
          <p className="muted">Плата не вернула данных по ячейкам.</p>
        ) : (
          <table className="table cells-table">
            <thead>
              <tr>
                <th>№</th>
                <th className="num">Напряжение</th>
                <th className="num">к среднему</th>
                <th>Шкала 2,50–3,65 В</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {cells.map((v, i) => {
                const pct = Math.max(0, Math.min(100, ((v - LO) / (HI - LO)) * 100));
                const isMin = st?.minIndex === i;
                const isMax = st?.maxIndex === i;
                const d = v - avg;
                const tags = [isMin && 'мин', isMax && 'макс', balancing.has(i + 1) && 'баланс'].filter(Boolean) as string[];
                return (
                  <tr key={i} className={`${isMin ? 'is-min' : ''} ${isMax ? 'is-max' : ''}`}>
                    <td>{i + 1}</td>
                    <td className="num"><b>{(v / 1000).toFixed(3)}</b> В</td>
                    <td className={`num ${Math.abs(d) > DELTA_WARN_MV ? 'warn' : 'muted'}`}>{d > 0 ? '+' : ''}{Math.round(d)} мВ</td>
                    <td><div className="bar-track cell-track"><div className="bar-fill" style={{ width: `${pct}%` }} /></div></td>
                    <td className="small">{tags.join(' · ') || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
