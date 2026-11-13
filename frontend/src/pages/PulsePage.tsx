import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import './pulse.css';
import { Icon } from '../components/Icon';
import { SkeletonList } from '../components/Skeleton';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Dialog } from '../components/ui/dialog';
import { Select } from '../components/ui/select';
import { api, ApiError } from '../lib/api';
import type { PulseActionType } from '../lib/api';
import { navigate } from '../lib/router';
import { getSocket } from '../lib/socket';
import { showToast } from '../lib/notifications';
import { feedback } from '../lib/feedback';
import { DateInput } from '../components/DateInput';
import { TaskChanges } from './pulse/TaskChanges';
import { effectText, ForecastRow as FRow, LoadRow, MainCardView, pulseApi, PulseScreen, StepView } from './pulse/pulse-api';
import { DecisionListDialog, PassportDialog } from './pulse/Passport';
import { MessageDialog } from './pulse/MessageDialog';
import { BalanceDialog } from './pulse/BalanceDialog';
import { HandoffDialog } from './pulse/HandoffDialog';
import { StaleDialog } from './pulse/StaleDialog';
import { Ring, Trial } from './pulse/Trial';
import { WeeklyDialog } from './pulse/WeeklyDialog';
import { decisionsApi } from './focus/decisions-api';

/**
 * «Пульс команды» по ТЗ #4890: руководитель за 10 секунд понимает, что не так, кто должен
 * действовать и что сделать прямо сейчас. Сверху вниз: индекс и тренд → «Главное — у вас»
 * → разбор решений (в Фокусе) → три шага с эффектом → нагрузка → прогноз → история.
 * Каждый блок подписан «сейчас» или «за 7 дней»; любое число — с паспортом по нажатию.
 * Своего списка решений здесь нет: разбор живёт в «Фокусе дня» (п. 13).
 */

type Full = Extract<PulseScreen, { mode: 'full' }>;
type Metric = 'decisions' | 'index' | 'team_review' | 'bottlenecks';

const ACTION_TITLE: Partial<Record<PulseActionType, string>> = { TASK_REASSIGN: 'Назначить исполнителя' };
const LABEL_TONE: Record<LoadRow['label'], 'danger' | 'warn' | 'ok' | 'neutral'> = { reviews: 'danger', overdue: 'warn', spare: 'ok', normal: 'neutral' };
const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 100; const b = n % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b > 1 && b < 5 ? few : many;
};

/** Прогрев по наведению на пункт меню — экран тяжелее прочих. */
export function prefetchPulse() { void pulseApi.screen().catch(() => undefined); }

/** Пульс → Фокус: сразу в режим разбора решений (п. 13). */
export function startReviewInFocus(ref = 'pulse') {
  try { sessionStorage.setItem('teamcrm.focusReview', '1'); } catch { /* без флага — по адресу */ }
  void pulseApi.event('run_started', ref).catch(() => undefined);
  navigate('/focus?review=1');
}

export function PulsePage() {
  const [data, setData] = useState<PulseScreen | null>(null);
  const [err, setErr] = useState('');
  const [passport, setPassport] = useState<Metric | null>(null);
  const [list, setList] = useState(false);
  const [formula, setFormula] = useState(false);
  const [message, setMessage] = useState<null | { userId: string; kind: 'overdue' | 'review'; taskIds?: string[] }>(null);
  const [balance, setBalance] = useState<null | { userId: string; taskIds?: string[]; toId?: string | null }>(null);
  const [handoff, setHandoff] = useState<null | { fromId: string; toId?: string | null; count?: number }>(null);
  const [stale, setStale] = useState(false);
  const [assign, setAssign] = useState(false);
  const [action, setAction] = useState<null | { type: PulseActionType; taskId: string; title: string }>(null);
  const [allSteps, setAllSteps] = useState(false);
  const [weekly, setWeekly] = useState(false);
  const [history, setHistory] = useState(false);

  const load = useCallback(() => {
    pulseApi.screen().then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось собрать «Пульс»'));
  }, []);
  useEffect(() => {
    load();
    const socket = getSocket();
    const on = () => load();
    socket.on('radar.changed', on);
    // решение в Фокусе сразу меняет счётчик и индекс здесь (п. 13)
    socket.on('focus.day.updated', on);
    window.addEventListener('teamcrm:tasks-changed', on);
    const vis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', vis);
    const t = window.setInterval(() => { if (!document.hidden) load(); }, 120_000);
    return () => {
      socket.off('radar.changed', on); socket.off('focus.day.updated', on);
      window.removeEventListener('teamcrm:tasks-changed', on); document.removeEventListener('visibilitychange', vis); window.clearInterval(t);
    };
  }, [load]);

  const loadPassport = useMemo(() => (passport === 'decisions' ? () => decisionsApi.passport() : () => pulseApi.passport(passport ?? 'index')), [passport]);
  const openPassport = (m: Metric) => { setPassport(m); void pulseApi.event('passport_opened', m).catch(() => undefined); };
  const num = (m: Metric, children: ReactNode) => (
    <button type="button" className="pp-num" onClick={() => openPassport(m)} title="Что за число">{children}</button>
  );

  const runStep = (s: StepView) => {
    switch (s.kind) {
      case 'nudge': if (s.userId) setMessage({ userId: s.userId, kind: 'overdue', taskIds: s.taskIds }); break;
      case 'remind_review': if (s.userId) setMessage({ userId: s.userId, kind: 'review' }); break;
      case 'stale': setStale(true); break;
      case 'balance': if (s.userId) setBalance({ userId: s.userId, taskIds: s.taskIds, toId: s.toId }); break;
      case 'assign': setAssign(true); break;
      default: break;
    }
  };

  const head = (
    <div className="page-head">
      <h2><Icon name="chart" size={18} /> Пульс команды</h2>
      {data && <span className="dim">обновлено {new Date(data.generatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>}
      <Button variant="ghost" size="sm" onClick={() => setWeekly(true)} aria-label="«Пульс недели» в Telegram" title="«Пульс недели» в Telegram"><Icon name="bell" size={14} /></Button>
      <Button variant="ghost" size="sm" onClick={load} aria-label="Обновить"><Icon name="refresh" size={14} /></Button>
    </div>
  );

  if (!data) {
    return (
      <div className="page pulse-page">
        {head}
        {err ? <div className="error-text">{err}</div> : <SkeletonList rows={8} />}
      </div>
    );
  }

  if (data.mode === 'trial') {
    return (
      <div className="page pulse-page">
        {head}
        <Trial steps={data.trial.steps} done={data.trial.done} daysLeft={data.trial.trialDaysLeft} />
        {weekly && <WeeklyDialog onClose={() => setWeekly(false)} />}
      </div>
    );
  }

  const d: Full = data;
  const h = d.head;
  const assignGroup = d.steps.groups.find((g) => g.key === 'none:assign');
  const staleProjects = d.forecast.stale;

  return (
    <div className="page pulse-page">
      {head}

      {/* 1–2. Шапка: индекс с трендом + «Главное — у вас» */}
      <div className="pulse-top">
        <section className={`pulse-card pulse-index pz-${h.zone}`} aria-label="Индекс здоровья команды">
          <button type="button" className="pulse-ring-btn" onClick={() => openPassport('index')} aria-label={`Индекс здоровья ${h.display} из 100 — что за число`}>
            <Ring value={h.display} zone={h.zone} size={112} />
          </button>
          <div className="pulse-index-text">
            <div className="pulse-cap">Индекс здоровья · {h.zoneTitle} · сейчас</div>
            <div className="pulse-headline">{h.headline}</div>
            <div className="pulse-trend">
              <span className={h.trend7 > 0 ? 'is-up' : h.trend7 < 0 ? 'is-down' : ''}>{h.trend7 > 0 ? '▲' : h.trend7 < 0 ? '▼' : '='} {effectText(h.trend7)} за 7 дней</span>
              {h.speed && <span> · {h.speed}</span>}
            </div>
            <div className="pulse-spark" role="img" aria-label={`Индекс за 8 недель: ${h.series.map((x) => Math.round(x)).join(', ')}`}>
              {h.series.map((v, i) => (
                <i key={i} className={i === h.series.length - 1 ? 'is-now' : ''} style={{ height: `${Math.max(8, Math.min(100, v))}%` }} title={`${Math.round(v)}`} />
              ))}
            </div>
            <div className="dim pulse-small">индекс за 8 недель · <button type="button" className="pulse-inline-link" onClick={() => setFormula(true)}>из чего складывается</button></div>
          </div>
        </section>
        <MainCard main={d.main} canAct={d.can.act} onStart={() => startReviewInFocus('pulse_main')} onPassport={() => openPassport('decisions')}
          onRemind={(id) => setMessage({ userId: id, kind: 'review' })} onHandoff={(x) => setHandoff(x)} onStep={runStep} />
      </div>

      {/* 3. Разбор решений — только кнопка в Фокус, своего списка здесь нет (п. 13) */}
      <section className="pulse-card pulse-run" aria-label="Разбор решений">
        <div className="pulse-card-head">
          <h3>Разбор решений <span className="dim pulse-sub">· сейчас</span></h3>
        </div>
        {d.decisions.count > 0 ? (
          <div className="pulse-run-row">
            <span>Ждут вашего решения: <b>{num('decisions', d.decisions.count)}</b> · по одной карточке, пачками по {d.decisions.take} · ≈ {d.decisions.etaMin} мин</span>
            <Button variant="primary" size="sm" onClick={() => startReviewInFocus('pulse_run')}>Начать разбор в Фокусе →</Button>
          </div>
        ) : <div className="dim">Решений от вас сейчас никто не ждёт.</div>}
      </section>

      {/* 4. Три шага с наибольшим эффектом */}
      <section className="pulse-card" aria-label="Три шага с наибольшим эффектом">
        <div className="pulse-card-head">
          <h3>{d.steps.top.length >= 3 ? '3 шага' : 'Шаги'} с наибольшим эффектом</h3>
          <span className="dim">из {num('bottlenecks', d.steps.total)} {plural(d.steps.total, 'узкого места', 'узких мест', 'узких мест')} · сейчас</span>
        </div>
        {d.steps.top.length === 0 && <div className="dim">Узких мест, где можно помочь одним шагом, нет.</div>}
        {d.steps.top.map((s) => (
          <div key={s.key} className="pulse-step">
            <div className="pulse-step-text">
              <b>{s.title}</b>
              <span className="dim pulse-small">{s.detail}</span>
            </div>
            <span className={`pulse-effect${s.effect > 0 ? '' : ' is-zero'}`} title="Сколько добавит индексу, если шаг сделан — по формуле индекса">индекс {effectText(s.effect)}</span>
            {d.can.act && <Button size="sm" variant="primary" onClick={() => runStep(s)}>{s.button}</Button>}
          </div>
        ))}
        {d.steps.total > 0 && (
          <button type="button" className="pulse-inline-link" onClick={() => setAllSteps(true)}>Показать все — сгруппированы по людям</button>
        )}
      </section>

      {/* 5. Нагрузка */}
      <LoadCard rows={d.load} canBalance={d.can.rebalance} onBalance={(id) => setBalance({ userId: id })} />

      {/* 6. Прогноз */}
      <section className="pulse-card" aria-label="Прогноз сроков">
        <div className="pulse-card-head">
          <h3>Прогноз сроков <span className="dim pulse-sub">· сейчас</span></h3>
          <span className="dim">по темпу последних 4 недель · это прогноз, а не план</span>
        </div>
        {d.forecast.rows.length === 0 && !staleProjects.length && <div className="dim">Открытых проектов с движением нет.</div>}
        <ForecastList rows={d.forecast.rows} onSaved={load} />
        {staleProjects.length > 0 && (
          <div className="pulse-stale">
            <div>
              <b>{staleProjects.length} {plural(staleProjects.length, 'проект стоит', 'проекта стоят', 'проектов стоят')} 4+ недели</b> — прогноз не построить
              <div className="dim pulse-small">{staleProjects.slice(0, 8).map((p) => p.name).join(', ')}{staleProjects.length > 8 ? ` и ещё ${staleProjects.length - 8}` : ''}</div>
            </div>
            <Button size="sm" variant="primary" onClick={() => setStale(true)}>Разобрать</Button>
          </div>
        )}
        {d.forecast.noData.length > 0 && (
          <div className="dim pulse-small">Ещё {d.forecast.noData.length} {plural(d.forecast.noData.length, 'проект', 'проекта', 'проектов')} без закрытых задач за 4 недели, но с движением — прогноз появится после первых закрытий: {d.forecast.noData.slice(0, 5).join(', ')}{d.forecast.noData.length > 5 ? '…' : ''}</div>
        )}
      </section>

      {/* 7. История переходов — свёрнута, по умолчанию 7 дней */}
      <section className="pulse-card" aria-label="История переходов">
        <button type="button" className="pulse-collapse" aria-expanded={history} onClick={() => setHistory((v) => !v)}>
          <Icon name={history ? 'chevron-down' : 'chevron-right'} size={14} /> <b>История переходов</b> <span className="dim">· за 7 дней · по журналу, а не по текущему статусу</span>
        </button>
        {history && <TaskChanges initialPreset="d7" embedded />}
      </section>

      {passport && (
        <PassportDialog load={loadPassport} onClose={() => setPassport(null)}
          onOpenList={passport === 'decisions' ? () => { setPassport(null); setList(true); } : undefined} />
      )}
      {list && <DecisionListDialog onClose={() => setList(false)} onStart={() => startReviewInFocus('pulse_list')} />}
      {formula && (
        <Dialog open onOpenChange={(o) => { if (!o) setFormula(false); }} size="lg" title={`Из чего складывается индекс ${h.display}`}
          description="Формула и веса прежние. Каждая часть — 40% уровня и 60% динамики к собственной базе команды за прошлые 4–8 недель (50 — как обычно): любое улучшение двигает индекс.">
          {h.formula.components.map((c) => (
            <div key={c.key} className="pulse-why-row">
              <span>
                {c.title} <span className="dim">· вес {Math.round(c.weight * 100)}%</span>
                <small className="dim pulse-why-hint">{c.hint} Сейчас {String(c.cur).replace('.', ',')}, обычно {String(c.base).replace('.', ',')}. Уровень {Math.round(c.level)}, динамика {Math.round(c.dynamics)}.</small>
              </span>
              <span className="pulse-bar"><i style={{ width: `${c.value}%` }} className={c.value >= 70 ? 'ok' : c.value >= 55 ? '' : 'mid'} /></span>
              <b>{Math.round(c.value)}</b>
            </div>
          ))}
          <div className="dim pulse-small">{h.formula.text}</div>
          <div className="dim pulse-small">Зоны: от 70 — здорово, 55–69 — норма, 40–54 — зона риска, до 40 — нужна помощь. Версия формулы: {h.version}.</div>
        </Dialog>
      )}
      {allSteps && (
        <Dialog open onOpenChange={(o) => { if (!o) setAllSteps(false); }} size="lg" title={`Все узкие места — ${d.steps.total}`} description="Сгруппированы по людям · сейчас">
          {d.steps.groups.map((g) => {
            const step = d.steps.top.find((x) => x.key === g.stepKey) ?? null;
            return (
              <div key={g.key} className="pulse-group">
                <div className="pulse-group-head">
                  <b>{g.me ? `${g.name} (вы)` : g.name}</b> <span className="dim">· {g.count}</span>
                  {g.me && g.items.some((i) => i.type === 'WAITING_REVIEW') && <Button size="sm" variant="primary" onClick={() => { setAllSteps(false); startReviewInFocus('pulse_all'); }}>Начать разбор в Фокусе →</Button>}
                  {!g.me && g.stepKey && d.can.act && (
                    <Button size="sm" variant="primary" onClick={() => {
                      setAllSteps(false);
                      if (step) runStep(step);
                      else if (g.stepKey?.startsWith('nudge:') && g.userId) setMessage({ userId: g.userId, kind: 'overdue' });
                      else if (g.stepKey?.startsWith('review:') && g.userId) setMessage({ userId: g.userId, kind: 'review' });
                      else if (g.stepKey === 'assign') setAssign(true);
                    }}>{g.stepKey === 'assign' ? 'Назначить' : 'Подготовить сообщение'}</Button>
                  )}
                </div>
                {g.items.slice(0, 12).map((i) => (
                  <div key={i.taskId} className="pulse-row">
                    <Badge tone={i.type === 'OVERDUE' || i.type === 'BLOCKED' ? 'danger' : 'warn'}>{i.typeTitle}</Badge>
                    <button type="button" className="pulse-link" onClick={() => { setAllSteps(false); navigate({ section: 'projects', projectId: i.projectId, taskId: i.taskId }); }}>#{i.taskId} {i.title}</button>
                    <span className="dim pulse-small">{i.why} · {i.projectName}</span>
                  </div>
                ))}
                {g.count > 12 && <div className="dim pulse-small">и ещё {g.count - 12}</div>}
              </div>
            );
          })}
        </Dialog>
      )}
      {assign && assignGroup && (
        <Dialog open onOpenChange={(o) => { if (!o) setAssign(false); }} size="md" title={`Без исполнителя — ${assignGroup.count}`}>
          {assignGroup.items.map((i) => (
            <div key={i.taskId} className="pulse-row">
              <button type="button" className="pulse-link" onClick={() => { setAssign(false); navigate({ section: 'projects', projectId: i.projectId, taskId: i.taskId }); }}>#{i.taskId} {i.title}</button>
              <Button size="sm" variant="outline" onClick={() => setAction({ type: 'TASK_REASSIGN', taskId: i.taskId, title: i.title })}>Назначить</Button>
            </div>
          ))}
        </Dialog>
      )}
      {action && <ActionDialog action={action} people={d.load} onClose={() => setAction(null)} onDone={load} />}
      {message && <MessageDialog {...message} onClose={() => setMessage(null)} onSent={load} />}
      {balance && <BalanceDialog {...balance} onClose={() => setBalance(null)} onDone={load} />}
      {handoff && <HandoffDialog {...handoff} onClose={() => setHandoff(null)} onDone={load} />}
      {stale && <StaleDialog projects={staleProjects} onClose={() => setStale(false)} onChanged={load} />}
      {weekly && <WeeklyDialog onClose={() => setWeekly(false)} />}
    </div>
  );
}

/** «Главное — у вас» (п. 2): одна главная проблема, кто пробка, последствия, цена и эффект. */
function MainCard({ main, canAct, onStart, onPassport, onRemind, onHandoff, onStep }: {
  main: MainCardView; canAct: boolean; onStart: () => void; onPassport: () => void;
  onRemind: (userId: string) => void; onHandoff: (x: { fromId: string; toId: string; count: number }) => void; onStep: (s: StepView) => void;
}) {
  const label = main.kind === 'me' ? 'Главное — у вас' : main.kind === 'none' ? 'Главное' : 'Главное сейчас';
  return (
    <section className={`pulse-card pulse-main is-${main.kind}`} aria-label={label}>
      <div className="pulse-cap pulse-main-cap">{label} · сейчас</div>
      <div className="pulse-headline">
        {main.kind === 'me'
          ? <><button type="button" className="pp-num" onClick={onPassport} title="Что за число">{main.count}</button>{main.title.slice(String(main.count).length)}</>
          : main.title}
      </div>
      <div className="pulse-main-why">{main.consequence}</div>
      {(main.cost || main.effect > 0) && (
        <div className="pulse-main-cost">
          {main.cost && <span>≈ {main.cost.minutes} минут на {main.cost.take} самых старых →</span>}
          {main.effect !== 0 && <span className="pulse-effect">индекс {effectText(main.effect)}</span>}
        </div>
      )}
      <div className="pulse-acts">
        {main.kind === 'me' && <Button variant="primary" onClick={onStart}>Начать разбор в Фокусе · {main.cost?.take ?? 10} шт. →</Button>}
        {main.kind === 'other' && main.who && canAct && <Button variant="primary" onClick={() => onRemind(main.who!.id)}>Напомнить: {main.who.name}</Button>}
        {main.kind === 'step' && main.step && canAct && <Button variant="primary" onClick={() => onStep(main.step!)}>{main.step.button}</Button>}
        {main.handoff && canAct && (
          <Button variant="outline" onClick={() => onHandoff({ fromId: main.handoff!.fromId, toId: main.handoff!.toId, count: main.handoff!.count })}>
            Передать часть: {main.handoff.toName}
          </Button>
        )}
      </div>
    </section>
  );
}

/** Нагрузка (п. 9): метки вместо процентов; «По часам» — только из оценок, с покрытием. */
function LoadCard({ rows, canBalance, onBalance }: { rows: LoadRow[]; canBalance: boolean; onBalance: (id: string) => void }) {
  const [tab, setTab] = useState<'tasks' | 'hours'>('tasks');
  return (
    <section className="pulse-card" aria-label="Нагрузка">
      <div className="pulse-card-head">
        <h3>Нагрузка <span className="dim pulse-sub">· сейчас</span></h3>
        <span className="view-switch" role="tablist" aria-label="Как считать">
          <button type="button" role="tab" aria-selected={tab === 'tasks'} className={`view-btn ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}>По задачам</button>
          <button type="button" role="tab" aria-selected={tab === 'hours'} className={`view-btn ${tab === 'hours' ? 'active' : ''}`} onClick={() => setTab('hours')}>По часам (по оценкам)</button>
        </span>
      </div>
      {rows.length === 0 && <div className="dim">Открытых задач у команды нет.</div>}
      {rows.map((r) => {
        const parts = tab === 'tasks'
          ? [r.reviews ? `ждут проверки ${r.reviews}` : '', `в работе ${r.active}`, r.urgent ? `срочных ${r.urgent}` : '', r.overdue ? `просрочено ${r.overdue}` : '', r.returned ? `вернули на доработку ${r.returned}` : '', r.submitted ? `сдано на проверку ${r.submitted}` : ''].filter(Boolean)
          : [r.hours.line];
        return (
          <div key={r.id} className="pulse-load-row">
            <div className="pulse-load-main">
              <div><b>{r.name}</b> <Badge tone={LABEL_TONE[r.label]}>{r.labelTitle}</Badge>{!r.available && <Badge tone="outline">не на месте</Badge>}</div>
              <span className="dim pulse-small">{parts.join(' · ')}</span>
            </div>
            {canBalance && r.active > 0 && <Button size="sm" variant="outline" onClick={() => onBalance(r.id)}>Балансировать</Button>}
          </div>
        );
      })}
      <div className="dim pulse-small">
        Проценты не показываем: «по задачам» — это количество, а не время. Часы — во второй вкладке, только по задачам с оценкой.
      </div>
    </section>
  );
}

/** Прогноз (п. 10): только проекты с расчётом; дата диапазоном; план — ссылкой «задать». */
function ForecastList({ rows, onSaved }: { rows: FRow[]; onSaved: () => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 5);
  return (
    <>
      {shown.map((p) => <ForecastItem key={p.id} p={p} onSaved={onSaved} />)}
      {rows.length > 5 && <button type="button" className="pulse-inline-link" onClick={() => setAll((v) => !v)}>{all ? 'Свернуть' : `Ещё ${rows.length - 5}`}</button>}
    </>
  );
}

function ForecastItem({ p, onSaved }: { p: FRow; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [plan, setPlan] = useState(p.targetDate ?? '');
  const date = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const meta = [`осталось ${p.remaining} ${plural(p.remaining, 'задача', 'задачи', 'задач')}`, `темп ${String(p.perWeek).replace('.', ',')} в неделю`,
    p.stuck ? `${p.stuck} без движения` : '', p.overdue ? `${p.overdue} ${plural(p.overdue, 'просрочена', 'просрочены', 'просрочено')}` : ''].filter(Boolean);
  return (
    <div className="pulse-fc2">
      <div className="pulse-fc2-left">
        <div>
          <button type="button" className="pulse-link" onClick={() => navigate({ section: 'projects', projectId: p.id })}>{p.name}</button>
          {p.risk === 'risk' && <Badge tone="danger">риск</Badge>}
          {p.risk === 'attention' && <Badge tone="warn">внимание</Badge>}
        </div>
        <span className="dim pulse-small">{meta.join(' · ')}</span>
      </div>
      <div className="pulse-fc2-right">
        <b className="pulse-fc2-date">{p.range.text}</b>
        <span className="dim pulse-small">
          {p.range.kind === 'approx' ? 'мало данных · ' : ''}
          {edit ? (
            <span className="pulse-plan-edit">
              <DateInput type="date" className="input" value={plan} aria-label={`План проекта ${p.name}`} onChange={(e) => setPlan(e.target.value)} />
              <Button size="sm" variant="secondary" onClick={() => { void api.pulseTarget(p.id, plan || null).then(() => { setEdit(false); onSaved(); }).catch(() => undefined); }}>Сохранить</Button>
            </span>
          ) : p.targetDate ? (
            <>план: {date(p.targetDate)}{p.late ? ` · позже плана на ${p.late} дн.` : ' · успеваете'} · <button type="button" className="pulse-inline-link" onClick={() => setEdit(true)}>изменить</button></>
          ) : (
            <>план: не задан · <button type="button" className="pulse-inline-link" onClick={() => setEdit(true)}>задать</button></>
          )}
        </span>
      </div>
    </div>
  );
}

/** Назначить исполнителя — сначала предпросмотр с сервера, потом подтверждение (ТЗ-19, §47). */
function ActionDialog({ action, people, onClose, onDone }: {
  action: { type: PulseActionType; taskId: string; title: string }; people: LoadRow[]; onClose: () => void; onDone: () => void;
}) {
  const [toUserId, setTo] = useState('');
  const [pv, setPv] = useState<{ id: string; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const sorted = useMemo(() => [...people].filter((p) => p.available).sort((a, b) => a.active - b.active), [people]);
  const preview = async () => {
    setBusy(true); setErr('');
    try { setPv(await api.pulsePreview({ type: action.type, taskId: action.taskId, toUserId })); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось подготовить'); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!pv) return;
    setBusy(true); setErr('');
    try {
      const r = await api.pulseConfirm(pv.id);
      feedback('action.confirmed'); showToast({ kind: 'saved', title: ACTION_TITLE[action.type] ?? 'Готово', body: r.text }); onDone(); onClose();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) { if (pv) void api.pulseReject(pv.id).catch(() => undefined); onClose(); } }}
      title={ACTION_TITLE[action.type] ?? 'Действие'} description={`#${action.taskId} ${action.title}`}
      footer={(
        <>
          <Button variant="ghost" onClick={() => { if (pv) void api.pulseReject(pv.id).catch(() => undefined); onClose(); }}>Отмена</Button>
          {!pv && <Button variant="primary" disabled={!toUserId} loading={busy} onClick={() => void preview()}>Показать, что будет</Button>}
          {pv && <Button variant="primary" loading={busy} onClick={() => void confirm()}>Подтвердить</Button>}
        </>
      )}>
      {!pv && (
        <Select ariaLabel="Кому передать" value={toUserId} onValueChange={setTo} placeholder="Кому передать"
          options={sorted.map((p) => ({ value: p.id, label: `${p.name} · в работе ${p.active}${p.overdue ? `, просрочено ${p.overdue}` : ''}` }))} />
      )}
      {pv && <div className="pulse-preview">{pv.preview}</div>}
      {err && <div className="error-text">{err}</div>}
    </Dialog>
  );
}
