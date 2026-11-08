import { useEffect, useMemo, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { Button } from './ui/button';
import { Select } from './ui/select';
import { api } from '../lib/api';
import { applyOrder, isHidden, MENU_PREFS_CHANGED, MenuPrefs, moveItem, PROTECTED, toggleHidden } from '../lib/menu-order';
import { favorites, FAVORITES_CHANGED, toggleFavorite, type Favorite } from '../lib/favorites';
import { toastSaved } from '../lib/notifications';
import { useAuth } from '../state/auth';
import { overlayProps } from '../lib/overlay';
import type { Project } from '../types';
import './nav-settings.css';

/** Пункты меню по группам, как на макете 02: рабочий день и команда с аккаунтом. */
const GROUPS: { title: string; items: { section: string; label: string; icon: IconName }[] }[] = [
  {
    title: 'Рабочий день', items: [
      { section: 'focus', label: 'Фокус дня', icon: 'target' },
      { section: 'projects', label: 'Проекты и задачи', icon: 'board' },
      { section: 'chat', label: 'Чаты и созвоны', icon: 'chat' },
      { section: 'fav', label: 'Избранное', icon: 'star' },
      { section: 'calendar', label: 'Календарь', icon: 'calendar' },
      { section: 'drafts', label: 'Черновики', icon: 'edit' },
      { section: 'news', label: 'Новости', icon: 'megaphone' },
    ],
  },
  {
    title: 'Команда и аккаунт', items: [
      { section: 'radar', label: 'Пульс команды', icon: 'chart' },
      { section: 'support', label: 'Служба заботы', icon: 'support' },
    ],
  },
];
/** Без страницы — главной не становятся. */
const BLOCKS = ['fav', 'drafts'];

/**
 * Настройки навигации (#4799 NAV01, макет 02) — личные: меняют меню только этому
 * человеку в этой компании, коллег и компанию не трогают. Скрытый пункт не пропадает —
 * его возвращают здесь же или в «Ещё разделы» в меню.
 */
export function NavSettingsPanel({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const [prefs, setPrefs] = useState<MenuPrefs>((user?.uiPrefs ?? {}) as MenuPrefs);
  const [picked, setPicked] = useState<string>('calendar');
  const [favs, setFavs] = useState<Favorite[]>(favorites());
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.listProjects().then(setProjects).catch(() => undefined); }, []);
  useEffect(() => {
    const re = () => setFavs([...favorites()]);
    window.addEventListener(FAVORITES_CHANGED, re);
    return () => window.removeEventListener(FAVORITES_CHANGED, re);
  }, []);

  const all = GROUPS.flatMap((g) => g.items);
  const ordered = useMemo(() => applyOrder(all, prefs).map((i) => i.section), [prefs]); // eslint-disable-line react-hooks/exhaustive-deps
  const home = prefs.home || 'focus';
  const label = (s: string) => all.find((i) => i.section === s)?.label ?? s;
  const projectFavs = favs.filter((f) => f.kind === 'project');

  const shift = (dir: -1 | 1) => {
    const shown = ordered.filter((s) => !isHidden(s, prefs));
    const at = shown.indexOf(picked);
    const neighbour = shown[at + dir];
    if (!neighbour) return;
    setPrefs({ ...prefs, order: moveItem(ordered, picked, ordered.indexOf(neighbour)) });
  };
  const makeHome = () => {
    if (BLOCKS.includes(picked)) return;
    setPrefs({ ...prefs, home: picked, order: moveItem(ordered, picked, 0), hidden: (prefs.hidden ?? []).filter((x) => x !== picked) });
  };
  const hide = () => {
    if (PROTECTED.includes(picked) || picked === home) return;
    setPrefs({ ...prefs, hidden: toggleHidden(prefs.hidden ?? [], picked) });
  };

  const save = async () => {
    setBusy(true);
    const next = {
      order: prefs.order ?? [], hidden: prefs.hidden ?? [], home: prefs.home ?? '',
      startup: prefs.startup ?? 'home', startProject: prefs.startProject ?? '',
    };
    try {
      await api.saveUiPrefs(next);
      window.dispatchEvent(new CustomEvent(MENU_PREFS_CHANGED, { detail: next }));
      toastSaved('Настройки навигации сохранены', 'Действуют только для вас');
    } catch { toastSaved('Не удалось сохранить', 'Попробуйте ещё раз'); }
    finally { setBusy(false); }
  };

  const startup = prefs.startup ?? 'home';
  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
    <aside className="drawer ns-drawer" onClick={(e) => e.stopPropagation()} aria-label="Настройки навигации">
    <div className="ns">
      <div className="ns-head">
        <div>
          <div className="dim">Личный кабинет</div>
          <h2>Настройки навигации</h2>
        </div>
        <Button variant="ghost" onClick={onClose}>Закрыть</Button>
      </div>
      <div className="ns-grid">
        <section className="ns-card">
          <h3>Настройки меню</h3>
          <p className="dim">Выберите пункт и поменяйте его место. Меню меняется только у вас.</p>
          <div className="ns-cols">
            {GROUPS.map((g) => (
              <div key={g.title}>
                <div className="ns-group">{g.title}</div>
                {ordered.filter((s) => g.items.some((i) => i.section === s)).map((s) => {
                  const it = g.items.find((i) => i.section === s)!;
                  const hidden = isHidden(s, prefs);
                  return (
                    <button key={s} className={`ns-row${picked === s ? ' is-on' : ''}${hidden ? ' is-hidden' : ''}`} onClick={() => setPicked(s)} aria-pressed={picked === s}>
                      <span className="ns-grip" aria-hidden="true">⠿</span>
                      <Icon name={it.icon} size={15} />
                      <span className="ns-name">{it.label}</span>
                      {home === s && <span className="ns-tag">главная</span>}
                      {hidden && <span className="ns-tag">скрыт</span>}
                    </button>
                  );
                })}
              </div>
            ))}
            <div>
              <div className="ns-group">Закреплено снизу</div>
              {[['robot', 'QEVO Bot'], ['building', 'Компания'], ['user', 'Аккаунт']].map(([icon, name]) => (
                <div key={name} className="ns-row is-fixed"><span className="ns-grip" aria-hidden="true">⠿</span><Icon name={icon as IconName} size={15} /><span className="ns-name">{name}</span></div>
              ))}
            </div>
          </div>
          <div className="ns-picked">Выбранный пункт: <b>{label(picked)}</b></div>
          <div className="ns-acts">
            <Button size="sm" variant="outline" onClick={makeHome} disabled={BLOCKS.includes(picked) || home === picked}>Сделать главным</Button>
            <Button size="sm" variant="outline" onClick={() => shift(-1)}>Выше</Button>
            <Button size="sm" variant="outline" onClick={() => shift(1)}>Ниже</Button>
            <Button size="sm" variant="outline" onClick={hide} disabled={home === picked}>{isHidden(picked, prefs) ? 'Вернуть' : 'Скрыть'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setPrefs({ ...prefs, order: [], hidden: [], home: '' })}>Сбросить</Button>
          </div>
          <p className="dim">Поиск по приложению и уведомления остаются в меню слева. Скрытый пункт не пропадает — он в «Ещё разделы».</p>
        </section>

        <div className="ns-side">
          <section className="ns-card">
            <h3>При входе открывать</h3>
            <p className="dim">Начальный экран для этого аккаунта.</p>
            {([
              ['focus_session', 'Продолжить активный Фокус', 'Если сессия есть — вернуться к задаче; иначе открыть выбранный экран'],
              ['project', 'Избранный проект', projectFavs.length ? 'Проекты и задачи → доска выбранного проекта' : 'Сначала добавьте проект в избранное звёздочкой'],
              ['home', `${label(home)}`, 'Главная страница из меню'],
            ] as const).map(([v, title, hint]) => (
              <label key={v} className={`ns-radio${startup === v ? ' is-on' : ''}`}>
                <input type="radio" name="ns-start" checked={startup === v} onChange={() => setPrefs({ ...prefs, startup: v })} disabled={v === 'project' && !projectFavs.length} />
                <span><b>{title}</b><span className="dim">{hint}</span></span>
              </label>
            ))}
            {startup === 'project' && projectFavs.length > 0 && (
              <Select ariaLabel="Какой проект открывать" size="sm" value={prefs.startProject || String(projectFavs[0].id)} onValueChange={(v) => setPrefs({ ...prefs, startProject: v })}
                options={projectFavs.map((f) => ({ value: String(f.id), label: f.title }))} />
            )}
          </section>
          <section className="ns-card">
            <h3>Избранное</h3>
            <p className="dim">Ваш список быстрых переходов. Все проекты остаются доступны через «Все проекты».</p>
            {favs.length === 0 && <p className="dim">Пока пусто — отметьте проект или задачу звёздочкой.</p>}
            {favs.slice(0, 8).map((f) => (
              <div key={`${f.kind}${f.id}`} className="ns-fav">
                <Icon name="star" size={14} /> <span className="ns-name">{f.title}</span>
                <button className="bb-link" onClick={() => toggleFavorite(f)}>Убрать из избранного</button>
              </div>
            ))}
            <div className="ns-fav">
              <Icon name="plus" size={14} />
              <Select ariaLabel="Добавить проект в избранное" size="sm" value="" onValueChange={(v) => { const p = projects.find((x) => String(x.id) === v); if (p) toggleFavorite({ kind: 'project', id: String(p.id), title: p.name }); }}
                options={[{ value: '', label: 'Добавить проект в избранное…' }, ...projects.filter((p) => !favs.some((f) => f.kind === 'project' && String(f.id) === String(p.id))).map((p) => ({ value: String(p.id), label: p.name }))]} />
            </div>
            <Button variant="primary" onClick={() => void save()} loading={busy}>Сохранить настройки</Button>
          </section>
        </div>
      </div>
    </div>
    </aside>
    </div>
  );
}
