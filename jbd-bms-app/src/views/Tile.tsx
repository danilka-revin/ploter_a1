// Оболочка плитки панели: заголовок, подсказок, кнопки и «разворот» на весь экран.
// Плитки живут в сетке 100dvh и прокручиваются внутри себя — страница не скроллится.
import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Tile({
  title, hint, tools, children, area, tone = '', scroll = true, expandable = true, footer,
}: {
  title: string;
  hint?: ReactNode;
  tools?: ReactNode;
  children: ReactNode;
  area?: string;
  tone?: string;
  scroll?: boolean;
  expandable?: boolean;
  footer?: ReactNode;
}) {
  const [max, setMax] = useState(false);
  const body = (
    <div className={`tile-body${scroll ? ' scroll' : ''}`}>{children}</div>
  );
  return (
    <section className={`tile ${tone}${max ? ' is-max' : ''}`} data-area={area} aria-label={title}>
      <header className="tile-head">
        <h2>{title}</h2>
        {hint && <span className="tile-hint">{hint}</span>}
        <div className="tile-tools">{tools}
          {expandable && (
            <button className="ic" title={max ? 'Вернуть размер' : 'Развернуть на весь экран'} onClick={() => setMax(!max)}>
              {max ? '⤡' : '⤢'}
            </button>
          )}
        </div>
      </header>
      {max ? <div className="tile-max"><div className="tile-max-inner">{body}{footer && <div className="tile-foot">{footer}</div>}</div>
        <button className="tile-max-close" onClick={() => setMax(false)} aria-label="Закрыть">✕</button>
      </div> : <>
        {body}
        {footer && <div className="tile-foot">{footer}</div>}
      </>}
    </section>
  );
}

/** Числовое поле с валидацией диапазона и подсветкой изменения. */
export function NumField({
  value, onInput, min, max, step, disabled, dirty, unit, tone = '',
}: {
  value: string;
  onInput: (v: string) => void;
  min?: number | null;
  max?: number | null;
  step?: number | null;
  disabled?: boolean;
  dirty?: boolean;
  unit?: string;
  tone?: string;
}) {
  const num = Number(value.replace(',', '.'));
  const bad = value.trim() !== '' && (!Number.isFinite(num) || (min != null && num < min) || (max != null && num > max));
  return (
    <span className={`nf ${bad ? 'is-bad' : ''} ${dirty ? 'is-dirty' : ''} ${tone}`}>
      <input
        type="text" inputMode="decimal" value={value} disabled={disabled}
        onChange={(e) => onInput(e.target.value)}
        title={[min != null ? `не меньше ${min}` : '', max != null ? `не больше ${max}` : '', step ? `шаг ${step}` : ''].filter(Boolean).join(', ')}
      />
      {unit && <i>{unit}</i>}
    </span>
  );
}

export function Chip({ on, onClick, children, title }: { on?: boolean; onClick?: () => void; children: ReactNode; title?: string }) {
  return (
    <button type="button" className={`chip${on ? ' on' : ''}`} onClick={onClick} title={title} aria-pressed={Boolean(on)}>
      {children}
    </button>
  );
}

export function Btn({
  children, onClick, tone = '', disabled, title, small,
}: {
  children: ReactNode; onClick?: () => void; tone?: '' | 'primary' | 'danger' | 'ok' | 'ghost' | 'warn'; disabled?: boolean; title?: string; small?: boolean;
}) {
  return (
    <button type="button" className={`b${tone ? ` ${tone}` : ''}${small ? ' sm' : ''}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

/** Чип-индикатор «вкл/выкл» с подтверждением в один клик внутри плитки. */
export function ConfirmButton({
  on, labelOn, labelOff, onConfirm, disabled, busy, tone = '', title,
}: {
  on: boolean; labelOn: string; labelOff: string; onConfirm: (next: boolean) => void; disabled?: boolean; busy?: boolean; tone?: string; title?: string;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const next = !on;
  return (
    <button
      type="button"
      className={`toggle ${on ? 'on' : 'off'} ${armed ? 'armed' : ''} ${tone}`}
      disabled={disabled || busy}
      title={title}
      onClick={() => {
        if (armed) { setArmed(false); onConfirm(next); return; }
        setArmed(true);
        timer.current = window.setTimeout(() => setArmed(false), 4000);
      }}
    >
      <span className="tg-state">{on ? 'ВКЛ' : 'ВЫКЛ'}</span>
      <span className="tg-label">{armed ? `Подтвердите: ${next ? labelOn : labelOff}` : on ? labelOn : labelOff}</span>
    </button>
  );
}

/** Кнопка действия, требующая подтверждения вторым нажатием (без модального окна). */
export function Armed({
  label, confirmLabel = 'Подтвердите', onClick, disabled, busy, tone = '', title, hint,
}: {
  label: string; confirmLabel?: string; onClick: () => void; disabled?: boolean; busy?: boolean; tone?: string; title?: string; hint?: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      className={`act ${armed ? 'armed' : ''} ${tone}`}
      title={title}
      disabled={disabled || busy}
      onClick={() => {
        if (armed) { setArmed(false); onClick(); return; }
        setArmed(true);
        timer.current = window.setTimeout(() => setArmed(false), 4000);
      }}
    >
      <span className="act-label">{busy ? '…' : armed ? confirmLabel : label}</span>
      {hint && <span className="act-hint">{hint}</span>}
    </button>
  );
}

/** Строка «параметр — значение» для паспорта и данных платы. */
export function KV({ k, v, tone = '', title }: { k: string; v: ReactNode; tone?: string; title?: string }) {
  return (
    <div className={`kv-row ${tone}`} title={title}>
      <span className="kv-k">{k}</span>
      <span className="kv-v">{v}</span>
    </div>
  );
}

export const num = (v: number | null | undefined, digits = 2, dash = '—') =>
  v === null || v === undefined || !Number.isFinite(v) ? dash : v.toFixed(digits).replace('.', ',');

export const mv = (v: number | null | undefined, digits = 3) => (v == null ? '—' : `${(v / 1000).toFixed(digits)} В`);
