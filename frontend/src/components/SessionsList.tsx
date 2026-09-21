import { Icon } from './Icon';
import { stampLabel } from '../lib/chat-text';
import type { SessionInfo } from '../lib/api';

/** «Pixel 7 · Android · оболочка 1.0 (1)» или «Chrome 141 · 10.0.0.1»: человек должен узнать своё устройство. */
export function sessionLabel(s: SessionInfo): string {
  if (s.device) {
    const os = s.device.platform === 'ios' ? 'iPhone' : s.device.platform === 'android' ? 'Android' : 'веб';
    return [s.device.model ?? os, s.device.nativeVersion ? `приложение ${s.device.nativeVersion}` : os].join(' · ');
  }
  return [(s.userAgent ?? 'устройство').slice(0, 38), s.ip ?? ''].filter(Boolean).join(' · ');
}

/**
 * Список сессий с кнопкой выхода — свой в профиле и сотрудника у руководства (ТЗ-9).
 * Один вид на оба места: «устройство» выглядит одинаково, где бы его ни отзывали.
 */
export function SessionsList({ sessions, onRevoke, busy }: {
  sessions: SessionInfo[];
  onRevoke: (id: string) => void;
  busy?: boolean;
}) {
  if (!sessions.length) return <p className="dim">Активных сессий нет.</p>;
  return (
    <div className="sessions-list">
      {sessions.map((s) => (
        <div key={s.id} className="team-row team-head sessions-row">
          <span className="sessions-main">
            <Icon name={s.device ? 'phone' : 'building'} size={14} />
            <span>
              {s.current && <span className="badge pnl-good">текущая</span>} {sessionLabel(s)}
              <span className="dim sessions-when"> · {stampLabel(s.lastUsedAt ?? s.createdAt)}</span>
            </span>
          </span>
          {!s.current && (
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onRevoke(s.id)} title="Завершить сессию — сразу, не через 15 минут">
              Выйти
            </button>
          )}
        </div>
      ))}
    </div>
  );
}