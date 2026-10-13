// Обзор: напряжение и ток батареи, заряд, защиты, балансировка, температуры.
import type { ReactNode } from 'react';
import type { Snapshot } from '../types';
import { fmtDate } from '../api';
import { Icon } from '../icons';

export function Overview({ snap, connected, error }: { snap: Snapshot | null; connected: boolean; error: string }) {
  if (!connected) return <Empty title="Плата не подключена">Выберите порт сверху и нажмите «Подключить». Для проверки без платы выберите «Демо-режим».</Empty>;
  if (!snap) return <Empty title="Читаю данные…">{error ? `Ошибка: ${error}` : 'Запрос к BMS…'}</Empty>;

  const b = snap.basic;
  const dir = b.packCurrent < -0.05 ? 'разряд' : b.packCurrent > 0.05 ? 'заряд' : 'ток почти нулевой';
  const faultsOk = b.faults.length === 0;
  const errorsNonZero = snap.errors ? Object.entries(snap.errors).filter(([, v]) => v > 0) : [];

  return (
    <div className="grid overview">
      {error && <div className="banner err inline">Последний опрос: {error}</div>}

      <section className="card hero">
        <div className="hero-top">
          <div>
            <div className="label">Напряжение батареи</div>
            <div className="big">{b.packVoltage.toFixed(2)}<span className="unit"> В</span></div>
          </div>
          <div className="hero-side">
            <div className="label">Ток</div>
            <div className={`value ${b.packCurrent < 0 ? 'neg' : b.packCurrent > 0 ? 'pos' : ''}`}>
              {b.packCurrent >= 0 ? '+' : ''}{b.packCurrent.toFixed(2)} А
            </div>
            <div className="muted small">{dir}</div>
          </div>
        </div>

        <div className="soc">
          <div className="soc-track"><div className="soc-fill" style={{ width: `${Math.max(0, Math.min(100, b.capacityPct))}%` }} /></div>
          <div className="soc-caption">
            <b>{b.capacityPct}%</b> заряда · {b.remainingAh.toFixed(1)} из {b.fullAh.toFixed(1)} Ач
          </div>
        </div>

        <div className="facts">
          <Fact label="Ячеек" value={String(b.cellCount)} />
          <Fact label="Циклов" value={String(b.cycles)} />
          <Fact label="Дата выпуска" value={fmtDate(b.manufactureDate.year, b.manufactureDate.month, b.manufactureDate.day)} />
          <Fact label="Прошивка" value={`0x${b.firmwareVersion.toString(16).toUpperCase().padStart(2, '0')}`} />
          <Fact label="Устройство" value={snap.deviceName || '—'} />
        </div>
      </section>

      <section className="card">
        <h3>Силовые ключи</h3>
        <div className="fet-row">
          <FetBadge label="Заряд" on={b.chargeFetOn} />
          <FetBadge label="Разряд" on={b.dischargeFetOn} />
        </div>
        <h3 className="mt">Балансировка</h3>
        <p className="muted small">
          {b.balancingCells.length === 0
            ? 'Сейчас не балансируется.'
            : `Балансируются ячейки: ${b.balancingCells.join(', ')}`}
        </p>
      </section>

      <section className="card">
        <h3>Температуры</h3>
        {b.temperatures.length === 0 ? (
          <p className="muted small">Датчики не сообщены платой.</p>
        ) : (
          <ul className="kv">
            {b.temperatures.map((t, i) => (
              <li key={i}><span>Датчик {i + 1}</span><b>{t.toFixed(1)} °C</b></li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h3 className="row-h">
          Защиты
          <span className={`chip-state ${faultsOk ? 'ok' : 'bad'}`}>
            <Icon name={faultsOk ? 'check' : 'alert'} size={13} />
            {faultsOk ? 'защит нет' : `активно: ${b.faults.length}`}
          </span>
        </h3>
        {faultsOk ? (
          <p className="muted small">Плата не сообщает о срабатывании защит.</p>
        ) : (
          <ul className="faults">{b.faults.map((f) => <li key={f.key}>{f.label}</li>)}</ul>
        )}
        <h3 className="mt">Счётчики срабатываний</h3>
        {snap.errors === null ? (
          <p className="muted small">Прошивка не отдаёт счётчики.</p>
        ) : errorsNonZero.length === 0 ? (
          <p className="muted small">Срабатываний не было.</p>
        ) : (
          <ul className="kv">
            {errorsNonZero.map(([k, v]) => <li key={k}><span>{ERR_LABEL[k] ?? k}</span><b>{v}</b></li>)}
          </ul>
        )}
      </section>
    </div>
  );
}

const ERR_LABEL: Record<string, string> = {
  sc: 'Короткое замыкание', chgoc: 'Перегрузка заряда', dsgoc: 'Перегрузка разряда',
  covp: 'Перенапряжение ячейки', cuvp: 'Понижение ячейки', chgot: 'Перегрев заряда',
  chgut: 'Переохлаждение заряда', dsgot: 'Перегрев разряда', dsgut: 'Переохлаждение разряда',
  povp: 'Перенапряжение батареи', puvp: 'Понижение батареи',
};

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="fact"><div className="label">{label}</div><div className="fact-v">{value}</div></div>;
}

function FetBadge({ label, on }: { label: string; on: boolean }) {
  return (
    <div className={`fet ${on ? 'on' : 'off'}`}>
      <Icon name="bolt" />
      <div><div className="fet-l">{label}</div><div className="fet-s">{on ? 'включён' : 'выключен'}</div></div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
