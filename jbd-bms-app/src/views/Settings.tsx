// Защиты и настройки: пороги из EEPROM платы. Только чтение — приложение
// ничего не записывает в BMS.
import { useState } from 'react';
import { api } from '../api';
import type { SettingsResponse } from '../types';
import { Empty } from './Overview';

export function Settings({ connected }: { connected: boolean }) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      setData(await api<SettingsResponse>('/api/settings', {}, 60_000));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  if (!connected) return <Empty title="Плата не подключена">Настройки читаются только с подключённой платы.</Empty>;

  return (
    <div className="grid settings">
      <section className="card wide">
        <div className="row-h">
          <div>
            <h3>Пороги защит и балансировки</h3>
            <p className="muted small">Значения из памяти BMS. Только чтение: приложение их не меняет.</p>
          </div>
          <button className="btn primary" onClick={load} disabled={loading}>
            {loading ? 'Читаю…' : data ? 'Перечитать' : 'Прочитать настройки'}
          </button>
        </div>
        {err && <div className="banner err inline">{err}</div>}
        {!data && !loading && <p className="muted">Нажмите «Прочитать настройки». Чтение занимает несколько секунд.</p>}
        {data && (
          <table className="table">
            <thead>
              <tr><th>Параметр</th><th className="num">Значение</th></tr>
            </thead>
            <tbody>
              {data.items.map((it) => (
                <tr key={it.key} title={it.error ?? ''}>
                  <td>{it.label}</td>
                  <td className="num">
                    {it.value === null
                      ? <span className="muted">нет данных</span>
                      : <>{formatValue(it.value)} <span className="muted">{it.unit}</span></>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function formatValue(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
