import { useState } from 'react';
import { Icon } from './Icon';
import { BottomSheet } from './BottomSheet';
import { queueBanner, removeQueued, retryQueued, type QueuedChange, type QueueSummary } from '../lib/offline-queue';

/**
 * Полоса состояния сети и очереди (ТЗ-9, волна 9).
 *
 * Пока сети нет — тонкая полоса сверху: «Нет сети · 3 изменения ожидают отправки».
 * Человек продолжает работать, а не гадает, ушло ли написанное. Сеть вернулась,
 * очередь ушла — полоса исчезает сама. Осталось непосланное (сервер отверг или
 * столкнулись с чужой правкой) — полоса остаётся, щелчок открывает список: что
 * именно, почему, и что с этим делать.
 */
export function OfflineBar({ online, items, summary, onRetry }: {
  online: boolean;
  items: QueuedChange[];
  summary: QueueSummary;
  onRetry: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const text = queueBanner(online, summary);
  if (!text) return null;
  const tone = !online ? 'offline' : summary.conflict || summary.failed ? 'attention' : 'sending';

  return (
    <>
      <button
        type="button"
        className={`offline-bar offline-bar-${tone}`}
        onClick={() => setOpen(true)}
        aria-live="polite"
      >
        <Icon name={!online ? 'plug' : tone === 'attention' ? 'alert' : 'upload'} size={14} />
        <span>{text}</span>
        {summary.total > 0 && <span className="offline-bar-more">Показать</span>}
      </button>
      {open && (
        <QueueSheet items={items} online={online} onClose={() => setOpen(false)} onRetry={onRetry} />
      )}
    </>
  );
}

const STATUS: Record<QueuedChange['status'], string> = {
  pending: 'ожидает отправки',
  failed: 'не принято сервером',
  conflict: 'столкнулось с чужой правкой',
};

function QueueSheet({ items, online, onClose, onRetry }: {
  items: QueuedChange[]; online: boolean; onClose: () => void; onRetry: () => Promise<boolean>;
}) {
  const [conflict, setConflict] = useState<QueuedChange | null>(null);
  if (conflict) return <ConflictSheet item={conflict} onClose={() => setConflict(null)} onDone={() => { setConflict(null); void onRetry(); }} />;
  return (
    <BottomSheet title={online ? 'Изменения, ожидающие отправки' : 'Нет сети — изменения отправятся позже'} onClose={onClose}>
      <div className="offline-list">
        {items.length === 0 && <div className="offline-empty">Всё отправлено</div>}
        {items.map((c) => (
          <div key={c.id} className={`offline-item offline-item-${c.status}`}>
            <div className="offline-item-text">
              <div className="offline-item-label">{c.label}{c.preview ? ` · ${c.preview.slice(0, 60)}` : ''}</div>
              <div className="offline-item-hint">{STATUS[c.status]}{c.error && c.status === 'failed' ? `: ${c.error}` : ''}</div>
            </div>
            <div className="offline-item-actions">
              {c.status === 'conflict' && (
                <button type="button" className="btn btn-primary" onClick={() => setConflict(c)}>Разобрать</button>
              )}
              {c.status === 'failed' && (
                <button type="button" className="btn" onClick={() => { retryQueued(c.id); void onRetry(); }} title="Повторить">
                  <Icon name="refresh" size={14} />
                </button>
              )}
              <button type="button" className="btn btn-delete" onClick={() => removeQueued(c.id)} title="Убрать из очереди">
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>
        ))}
        {online && items.some((c) => c.status === 'pending') && (
          <button type="button" className="btn" onClick={() => void onRetry()}>Отправить сейчас</button>
        )}
      </div>
    </BottomSheet>
  );
}

const FIELD_LABEL: Record<string, string> = { title: 'Название', description: 'Описание', priority: 'Приоритет' };

/**
 * Конфликт версий: два варианта рядом, решает человек.
 *
 * «Оставить моё» — та же правка уходит поверх текущей версии (If-Match = версия сервера).
 * «Взять серверное» — своя правка выбрасывается. Слить автоматически не пытаемся:
 * склеенное описание из двух половин хуже, чем любая из них целиком.
 */
export function ConflictSheet({ item, onClose, onDone }: { item: QueuedChange; onClose: () => void; onDone: () => void }) {
  const mine = (item.body ?? {}) as Record<string, unknown>;
  const theirs = item.conflict?.current ?? {};
  const fields = (item.conflict?.fields ?? Object.keys(mine)).filter((f) => f in FIELD_LABEL);
  const serverVersion = typeof theirs.version === 'number' ? theirs.version : null;
  return (
    <BottomSheet title="Задачу уже изменили" onClose={onClose}>
      <div className="conflict-body">
        <p className="conflict-hint">Пока вы правили без сети, задачу изменил кто-то ещё. Какой вариант оставить?</p>
        {fields.map((f) => (
          <div key={f} className="conflict-field">
            <div className="conflict-field-name">{FIELD_LABEL[f] ?? f}</div>
            <div className="conflict-side">
              <div className="conflict-side-title">Ваш вариант</div>
              <div className="conflict-side-text">{String(mine[f] ?? '—')}</div>
            </div>
            <div className="conflict-side">
              <div className="conflict-side-title">На сервере сейчас</div>
              <div className="conflict-side-text">{String(theirs[f] ?? '—')}</div>
            </div>
          </div>
        ))}
        <div className="conflict-actions">
          <button type="button" className="btn btn-primary" onClick={() => { retryQueued(item.id, serverVersion); onDone(); }}>
            Оставить мой вариант
          </button>
          <button type="button" className="btn" onClick={() => { removeQueued(item.id); onDone(); }}>
            Взять серверный
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
