import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../Icon';
import { Avatar } from '../Avatar';
import { Button } from '../ui/button';
import { api } from '../../lib/api';
import { hubApi } from '../../lib/hub-api';
import { navigate } from '../../lib/router';
import { initialsOf } from '../../lib/initials';
import { toastSaved } from '../../lib/notifications';
import { lazyComponent } from '../../lib/lazy';
import { useAuth } from '../../state/auth';
import { useIsPhone } from '../../hooks/useMediaQuery';
import { addedSummary, addedTotal, canCollect, dayLabel, hostOf, itemIcon, readCollapsed, safeHref, shortlist, writeCollapsed } from '../../lib/hub';
import { AskBox, DecisionRow, ItemRow, errText } from './parts';
import { HubRunDialog } from './HubRunDialog';
import { useHub } from './useHub';
import type { HubTab } from './HubPassport';
import './hub.css';

/* Паспорт с формами и вкладками — отдельным куском: колонку видят все, паспорт открывают не все. */
const HubPassport = lazyComponent(() => import('./HubPassport').then((m) => m.HubPassport));

/**
 * Инфоцентр проекта (#4659) — нулевая колонка доски.
 *
 * Стоит ПЕРЕД колонками доски, но не среди них: её нет в board.columns, поэтому
 * «первая колонка», порядок и перенос карточек её не видят. Не перетаскивается и не
 * принимает карточки — у неё нет обработчиков переноса вовсе.
 *
 * Три состояния: колонка 272 px → полоса 30 px (книга и бейдж) → паспорт на весь
 * экран. Свёрнута ли — помним на человека и проект. На телефоне по умолчанию полоса,
 * а «развернуть» сразу открывает паспорт: колонка в 86% экрана отняла бы доску.
 *
 * `variant="button"` — для вида «Список»: кнопка «Инфоцентр» в шапке, открывающая паспорт.
 */
export function HubColumn({ projectId, ownerId, variant = 'column' }: {
  projectId: string;
  ownerId?: string | null;
  variant?: 'column' | 'button';
}) {
  const { user } = useAuth();
  const phone = useIsPhone();
  const uid = String(user?.id ?? '');
  const { view, error, loading, reload } = useHub(projectId);
  // выбор человека на компьютере; на телефоне всегда полоса — «развернуть» там открывает паспорт
  const [choice, setChoice] = useState<{ projectId: string; collapsed: boolean } | null>(null);
  const collapsed = phone || (choice?.projectId === projectId ? choice.collapsed : readCollapsed(uid, projectId, false));
  const setCollapsed = (v: boolean) => { setChoice({ projectId, collapsed: v }); writeCollapsed(uid, projectId, v); };
  const [passport, setPassport] = useState<{ tab: HubTab; add?: boolean } | null>(null);
  // номер прогона запоминаем при открытии: окно гасит бейдж (seen), и unseen тут же становится пустым
  const [runId, setRunId] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [note, setNote] = useState('');

  const unseen = view?.librarian.unseen ?? null;
  const badge = unseen ? addedSummary(unseen.added) : '';
  const mayCollect = canCollect(user?.role, uid, ownerId ?? view?.team.owner?.id);

  const collect = async () => {
    setCollecting(true); setNote('');
    // Сбор идёт прямо в запросе — показываем итог, а не «запущен»: молча пустой сбор выглядел как «ничего не происходит».
    try {
      const r = await hubApi.collect(projectId);
      if (r.status === 'failed') {
        setNote(`Не получилось собрать${r.run.error ? `: ${r.run.error}` : ''}. Попробуйте ещё раз через минуту.`);
      } else if (addedTotal(r.run.added) > 0) {
        await reload();
        setRunId(r.run.id);
      } else {
        toastSaved('Сбор закончен — нового нет', 'В чатах, созвонах и задачах проекта не нашлось новых ссылок, файлов и решений. Первый сбор смотрит последний месяц, дальше — сутки.');
      }
    }
    catch (e) { setNote(errText(e, 'Не удалось запустить сбор')); }
    finally { setCollecting(false); }
  };

  /*
    Окна — в body, а не внутри колонки: у колонки backdrop-filter, и для position: fixed
    она становится рамкой — паспорт «на весь экран» сжимался до ширины колонки.
  */
  const overlays = createPortal(
    <>
      {passport && view && (
        <HubPassport
          projectId={projectId}
          view={view}
          reload={reload}
          initialTab={passport.tab}
          initialAdd={passport.add}
          aiBadge={badge}
          onOpenRun={unseen ? () => setRunId(unseen.id) : undefined}
          onCollect={mayCollect ? collect : undefined}
          onClose={() => setPassport(null)}
        />
      )}
      {runId && (
        <HubRunDialog projectId={projectId} runId={runId} onClose={() => setRunId(null)} onChanged={() => void reload()} />
      )}
    </>,
    document.body,
  );

  if (variant === 'button') {
    return (
      <>
        <Button variant="ghost" size="sm" onClick={() => setPassport({ tab: 'passport' })} disabled={!view} title="Паспорт проекта: ссылки, команда, решения, поиск">
          <Icon name="book" size={15} /> Инфоцентр
          {badge && <span className="hub-dot" aria-label={`ИИ обновил: ${badge}`} />}
        </Button>
        {overlays}
      </>
    );
  }

  if (collapsed) {
    const total = unseen ? addedTotal(unseen.added) : 0;
    return (
      <aside className="hub-col hub-col-strip" aria-label="Инфоцентр проекта">
        <button
          type="button"
          className="hub-strip-btn"
          onClick={() => { if (!phone) setCollapsed(false); else if (view) setPassport({ tab: 'passport' }); }}
          title={phone ? 'Открыть Инфоцентр проекта' : 'Развернуть Инфоцентр'}
          aria-label={`${phone ? 'Открыть' : 'Развернуть'} Инфоцентр${badge ? `. ИИ обновил: ${badge}` : ''}`}
        >
          <Icon name="book" size={16} />
          {total > 0 && <span className="hub-strip-count" aria-hidden="true">+{total}</span>}
          <span className="hub-strip-label" aria-hidden="true">Инфоцентр</span>
        </button>
        {overlays}
      </aside>
    );
  }

  const p = view?.project;
  const links = view ? shortlist(view.passport.filter((i) => i.kind === 'link'), 3) : [];
  const kb = view ? shortlist(view.knowledge, 5) : [];
  const last = view?.decisions.items[0] ?? null;
  const owner = view?.team.owner ?? null;
  const ownerIsMe = owner && String(owner.id) === uid;
  const write = async () => {
    if (!owner) return;
    try { const dm = await api.openDm(String(owner.id)); navigate({ section: 'chat', chatId: String(dm.id) }); }
    catch (e) { setNote(errText(e, 'Не удалось открыть чат')); }
  };
  const cardEmpty = p && !p.mission && !links.length;

  return (
    <aside className="hub-col" aria-label="Инфоцентр проекта">
      <header className="hub-head">
        <span className="hub-head-title"><Icon name="book" size={16} /> Инфоцентр</span>
        <span className="hub-head-acts">
          {mayCollect && (
            <Button variant="ghost" size="icon-sm" onClick={() => void collect()} disabled={collecting} aria-label="Собрать сейчас" title="Собрать сейчас: ИИ разберёт события за сутки">
              {collecting ? <span className="ui-spinner" style={{ width: 13, height: 13 }} /> : <Icon name="refresh" size={14} />}
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={() => view && setPassport({ tab: 'passport' })} disabled={!view} aria-label="На весь экран" title="На весь экран: паспорт проекта">
            <Icon name="maximize" size={14} />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setCollapsed(true)} aria-label="Свернуть" title="Свернуть в полосу">
            <Icon name="chevron-left" size={14} />
          </Button>
        </span>
      </header>
      {badge && (
        <button type="button" className="hub-badge" onClick={() => setRunId(unseen!.id)} title="Посмотреть, что добавил ИИ">
          <Icon name="sparkles" size={13} /> <span>ИИ обновил: {badge}</span>
        </button>
      )}
      {note && <p className="hub-note" role="status">{note}</p>}

      <div className="hub-body">
        {loading && !view && <p className="hub-hint" role="status">Загружаю…</p>}
        {error && !view && (
          <div className="hub-card">
            <p className="hub-err" role="alert">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void reload()}>Повторить</Button>
          </div>
        )}
        {view && p && (
          <>
            {/* 1. Визитка */}
            <section className="hub-card" aria-labelledby={`hub-card-${projectId}`}>
              <h3 className="hub-card-title" id={`hub-card-${projectId}`}>{p.name}</h3>
              {p.mission
                ? <p className="hub-mission hub-clamp">{p.mission}</p>
                : cardEmpty && <p className="hub-hint">Добавьте миссию и сайт проекта — новичку не придётся спрашивать.</p>}
              {p.audience && <p className="hub-meta hub-clamp">Для кого: {p.audience}</p>}
              {links.length > 0 && (
                <ul className="hub-chips">
                  {links.map((l) => {
                    const href = safeHref(l.url);
                    return (
                      <li key={l.id}>
                        {href
                          ? <a className="hub-chip" href={href} target="_blank" rel="noopener noreferrer" title={l.url ?? ''}><Icon name={itemIcon(l)} size={12} /> {l.title || hostOf(l.url)}</a>
                          : <span className="hub-chip"><Icon name={itemIcon(l)} size={12} /> {l.title}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
              {p.targetDate && <p className="hub-meta"><Icon name="calendar" size={12} /> Срок проекта: {dayLabel(p.targetDate)}</p>}
              {owner && (
                <div className="hub-owner">
                  <Avatar path={owner.avatarUrl ?? null} fallback={initialsOf(owner.name)} className="avatar-sm" />
                  <span className="hub-owner-text"><span className="hub-owner-name">{owner.name}</span><span className="hub-meta">руководитель проекта</span></span>
                  {!ownerIsMe && <Button variant="outline" size="sm" onClick={() => void write()}><Icon name="chat" size={13} /> Написать</Button>}
                </div>
              )}
              {/* Вход в паспорт — всегда на виду: раньше ссылка пропадала после заполнения, и
                  миссию с аудиторией было не найти — оставалась только иконка «На весь экран» (26.10) */}
              {cardEmpty && view.canEdit
                ? <Button variant="link" size="sm" onClick={() => setPassport({ tab: 'passport' })}>Заполнить паспорт</Button>
                : (
                  <Button variant="link" size="sm" onClick={() => setPassport({ tab: 'passport' })}>
                    {view.canEdit ? 'Паспорт проекта — посмотреть и изменить' : 'Паспорт проекта'}
                  </Button>
                )}
            </section>

            {/* 2. База знаний */}
            <section className="hub-card" aria-label="База знаний">
              <h3 className="hub-card-label">База знаний</h3>
              {kb.length ? (
                <ul className="hub-list">
                  {kb.map((it) => <ItemRow key={it.id} item={it} compact onError={setNote} />)}
                </ul>
              ) : (
                <p className="hub-hint">ТЗ, брендбук, макеты и репозиторий — в одном месте. ИИ соберёт ссылки из чатов сам каждое утро в 8:00.</p>
              )}
              <div className="hub-card-foot">
                {view.canEdit && (
                  <Button variant="ghost" size="sm" onClick={() => setPassport({ tab: 'knowledge', add: true })}><Icon name="plus" size={13} /> добавить</Button>
                )}
                {view.knowledge.length > kb.length && (
                  <Button variant="link" size="sm" onClick={() => setPassport({ tab: 'knowledge' })}>Все ({view.knowledge.length})</Button>
                )}
              </div>
            </section>

            {/* 3. Хроника решений */}
            <section className="hub-card" aria-label="Хроника решений">
              <h3 className="hub-card-label">Последнее решение</h3>
              {last ? (
                <ul className="hub-list"><DecisionRow d={last} clamp /></ul>
              ) : (
                <p className="hub-hint">Решения появятся сами — из итогов созвонов и рабочих чатов проекта.</p>
              )}
              {view.decisions.total > 1 && (
                <div className="hub-card-foot">
                  <Button variant="link" size="sm" onClick={() => setPassport({ tab: 'decisions' })}>Все решения ({view.decisions.total})</Button>
                </div>
              )}
            </section>
          </>
        )}
      </div>
      {/* 4. Поиск — прибит к низу колонки: карточки над ним прокручиваются, поле видно всегда */}
      {view && (
        <section className="hub-foot" aria-label="Поиск по проекту">
          <AskBox projectId={projectId} />
        </section>
      )}
      {overlays}
    </aside>
  );
}
