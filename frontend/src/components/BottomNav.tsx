import { Icon } from './Icon';
import { navigate, Route } from '../lib/router';
import type { NavCounters } from '../hooks/useNavCounters';

/**
 * Нижние вкладки на телефоне (ТЗ-9, волна 1).
 *
 * Панель разделов на телефоне пряталась за «гамбургером» в верхнем левом углу — туда
 * не дотянуться большим пальцем, и каждый переход стоил двух нажатий. Пакет мобильного
 * ТЗ требует ровно пять мест внизу: Фокус · Проекты · Чаты · Миты · Ещё. «Ещё»
 * открывает ту же панель разделов, что и раньше, — в ней всё остальное: задачи,
 * календарь, новости, служба заботы, секретарь, кабинет и аккаунт. Второго меню не
 * заводим: панель одна, и настроенный человеком порядок разделов живёт в ней.
 */
const TABS: { key: string; label: string; icon: 'target' | 'board' | 'chat' | 'record' | 'more'; go: () => void; match: (r: Route) => boolean }[] = [
  { key: 'focus', label: 'Фокус', icon: 'target', go: () => navigate({ section: 'focus' }), match: (r) => r.section === 'focus' },
  { key: 'projects', label: 'Проекты', icon: 'board', go: () => navigate({ section: 'projects' }), match: (r) => r.section === 'projects' },
  { key: 'chat', label: 'Чаты', icon: 'chat', go: () => navigate({ section: 'chat' }), match: (r) => r.section === 'chat' && !r.view },
  { key: 'meetings', label: 'Миты', icon: 'record', go: () => navigate({ section: 'chat', view: 'meetings' }), match: (r) => r.section === 'chat' && r.view === 'meetings' },
];

export function BottomNav({ route, unread, counters, onMore }: {
  route: Route;
  unread: number;
  counters: NavCounters;
  /** «Ещё» — открыть панель разделов. */
  onMore: () => void;
}) {
  const badge = (key: string): number => (key === 'chat' ? unread
    : key === 'focus' ? counters.focus.decide
      : key === 'projects' ? counters.tasks?.unread ?? 0
        : 0);
  return (
    <nav className="bottom-nav" aria-label="Разделы">
      {TABS.map((t) => {
        const n = badge(t.key);
        return (
          <button
            key={t.key}
            className={`bottom-nav-item${t.match(route) ? ' active' : ''}`}
            onClick={t.go}
            aria-current={t.match(route) ? 'page' : undefined}
          >
            <span className="bottom-nav-icon">
              <Icon name={t.icon} size={22} />
              {n > 0 && <span className="bottom-nav-badge">{n > 99 ? '99+' : n}</span>}
            </span>
            <span className="bottom-nav-label">{t.label}</span>
          </button>
        );
      })}
      <button className="bottom-nav-item" onClick={onMore} aria-label="Ещё разделы" aria-haspopup="menu">
        <span className="bottom-nav-icon"><Icon name="more" size={22} /></span>
        <span className="bottom-nav-label">Ещё</span>
      </button>
    </nav>
  );
}