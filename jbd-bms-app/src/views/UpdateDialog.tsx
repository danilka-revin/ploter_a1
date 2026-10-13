// Диалог обновления «с main»: как в PSBees — проверка, этапы и перезапуск.
import type { UpdateSnapshot } from '../types';
import { Icon } from '../icons';

export function UpdateDialog({ update, onClose, onCheck, onRun }: {
  update: UpdateSnapshot | null;
  onClose: () => void;
  onCheck: () => void;
  onRun: () => void;
}) {
  const running = Boolean(update && (update.phase === 'running' || update.running));
  const restarting = Boolean(update?.restartRequired);

  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !running) onClose(); }}>
      <div className="modal update-modal" role="dialog" aria-modal="true" aria-labelledby="upd-title">
        <h2 id="upd-title">Обновление программы</h2>

        {!update && <p>Проверяю GitHub…</p>}

        {update && (
          <>
            <div className="upd-grid">
              <div className="upd-row"><span className="upd-lab">Ветка</span><span className="mono">{update.branch}</span></div>
              <div className="upd-row"><span className="upd-lab">Установлено</span>
                <span className="mono">{update.currentSha ? update.currentSha.slice(0, 7) : '—'}</span></div>
              <div className="upd-row"><span className="upd-lab">Последнее на GitHub</span>
                <span className="mono">{update.latestSha ? update.latestSha.slice(0, 7) : '—'}
                  {update.latestDate && <span className="muted"> · {new Date(update.latestDate).toLocaleString('ru-RU')}</span>}
                </span></div>
              {update.latestMessage && <div className="upd-row"><span className="upd-lab">Изменения</span><span>{update.latestMessage}</span></div>}
            </div>

            <div className={`banner inline ${update.phase === 'error' ? 'err' : update.updateAvailable ? 'ok' : 'info'}`}>
              {update.message}
            </div>

            {update.steps.some((s) => s.state !== 'wait') && (
              <ol className="steps">
                {update.steps.map((s) => (
                  <li key={s.id} className={`step ${s.state}`}>
                    <span className="step-ico">
                      {s.state === 'done' || s.state === 'skip' ? <Icon name="check" size={14} />
                        : s.state === 'error' ? <Icon name="alert" size={14} />
                        : s.state === 'run' ? <span className="spin" /> : null}
                    </span>
                    <span>{s.title}</span>
                    {s.detail && <span className="muted small"> — {s.detail}</span>}
                  </li>
                ))}
              </ol>
            )}

            {restarting && <p className="muted small">Программа перезапускается, страница обновится сама…</p>}
          </>
        )}

        <div className="foot">
          <button className="btn" onClick={onCheck} disabled={running || restarting}>Проверить</button>
          <button className="btn" onClick={onClose} disabled={running || restarting}>Закрыть</button>
          <button className="btn primary" onClick={onRun}
            disabled={!update?.updateAvailable || running || restarting}>
            Обновить с main
          </button>
        </div>
      </div>
    </div>
  );
}
