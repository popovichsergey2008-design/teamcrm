import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { confirmAction } from '../../components/ui/dialog';
import { ApiError, request } from '../../lib/api';
import { toastSaved } from '../../lib/notifications';
import { navigate } from '../../lib/router';
import { dur, focusApi, hm, PlusDay, DaySlot } from './focus-api';

/**
 * Утро (#4891, п. 1, 1а, 2): бриф в 2–3 предложения, ёмкость дня (рабочий день − встречи =
 * доступно; запланировано и резерв), полоса дня, таймлайн по часам. «Принять план» ставит
 * блоки задач в календарь. Перегруз — с конкретным предложением; принять перегруженный
 * план можно только через «Всё равно оставить». Сроки и даты меняются только по «Применить».
 */
export function MorningPlan({ day, accepted, busy, onDay, onEdit, onRefresh, onReload }: {
  day: PlusDay; accepted: boolean; busy: boolean;
  onDay: (d: PlusDay) => void; onEdit: () => void; onRefresh: () => void; onReload: () => void;
}) {
  const [err, setErr] = useState('');
  const [why, setWhy] = useState(false);
  const [overdue, setOverdue] = useState<{ taskId: string; title: string; startsAt: string; endsAt: string; label: string }[] | null>(null);
  const [working, setWorking] = useState(false);
  const c = day.capacity;
  const run = async (fn: () => Promise<unknown>) => {
    setWorking(true); setErr('');
    try { await fn(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); } finally { setWorking(false); }
  };
  const accept = () => run(async () => {
    if (c.overloadMin > 0) {
      const ok = await confirmAction({
        title: `День перегружен на ${dur(c.overloadMin)}`,
        description: day.overload ? `Можно перенести «${day.overload.title}» на ${day.overload.label} — там есть место.` : 'Задач больше, чем свободного времени.',
        confirmLabel: 'Всё равно оставить', cancelLabel: 'Отмена',
      });
      if (!ok) return;
      onDay(await focusApi.acceptAnyway());
    } else onDay(await focusApi.accept());
    window.dispatchEvent(new Event('teamcrm:tasks-changed'));
    toastSaved('План принят', 'задачи поставлены в календарь');
  });
  const listen = () => {
    try {
      const u = new SpeechSynthesisUtterance([day.brief.yesterday, day.brief.text].filter(Boolean).join('. '));
      u.lang = 'ru-RU'; window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    } catch { /* озвучки нет — текст на экране */ }
  };
  const total = Math.max(1, c.workMin);
  const seg = (min: number) => `${Math.max(0, (min / total) * 100)}%`;

  if (day.dayOff) {
    return (
      <section className="fp-card" aria-label="Выходной">
        <div className="fp-title">Сегодня выходной — планирование выключено</div>
        {day.nextWorkday && <div className="dim">Следующий рабочий день: {day.nextWorkday.label}.</div>}
        <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => navigate({ section: 'calendar' })}><Icon name="calendar" size={14} /> Спланировать следующий рабочий день</button>
      </section>
    );
  }

  return (
    <section className="fp-morning" aria-label="План дня">
      <div className="fp-card fp-main">
        <div className="fp-head">
          <div className="dim fp-small">рабочий день {day.workStart}–{day.workEnd}</div>
          <button type="button" className="fp-refresh dim" title="Обновить план" onClick={onReload}>план обновлён {hm(day.updatedAt)} <Icon name="refresh" size={12} /></button>
        </div>
        {day.brief.yesterday && <div className="dim fp-small">{day.brief.yesterday}</div>}
        <p className="fp-brief">{day.brief.text}</p>
        <div className="fp-nums">
          <div><b>{dur(c.workMin)}</b><span>рабочий день</span></div>
          <div><b>{dur(c.meetingMin)}</b><span>встречи (уже вычтены)</span></div>
          <div><b>{dur(c.plannedMin)}</b><span>запланировано</span></div>
          {c.overloadMin > 0
            ? <div className="bad"><b>−{dur(c.overloadMin)}</b><span>не помещается</span></div>
            : <div className="ok"><b>{dur(c.reserveMin)}</b><span>резерв</span></div>}
        </div>
        <div className="fp-bar" aria-hidden="true">
          <span className="meet" style={{ width: seg(c.meetingMin) }} />
          <span className="deep" style={{ width: seg(Math.min(c.plannedMin, c.availableMin)) }} />
          <span className="rev" style={{ width: seg(c.reviewsMin) }} />
        </div>
        <div className="fp-legend dim"><span><i className="meet" />встречи</span><span><i className="deep" />глубокая работа</span><span><i className="rev" />проверки и решения</span><span><i className="res" />резерв</span></div>

        {c.overloadMin > 0 && (
          <div className="fp-warn" role="status">
            <b>День перегружен на {dur(c.overloadMin)}.</b>
            {day.overload ? <> Перенести «{day.overload.title}» на {day.overload.label} — там есть место.
              <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" disabled={working} onClick={() => void run(async () => { onDay(await focusApi.overload()); toastSaved('Перенесено', `${day.overload!.title} → ${day.overload!.label}`); })}>Перенести</button></>
              : ' Уберите задачу из тройки или сократите оценку.'}
          </div>
        )}
        {day.overdue.length > 0 && (
          <div className="fp-overdue">
            <span><Icon name="alert" size={13} /> Просрочено вне плана: {day.overdue.length}</span>
            {!overdue ? (
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" disabled={working} onClick={() => void run(async () => setOverdue((await focusApi.overduePreview()).placements))}>Разложить по дням</button>
            ) : (
              <div className="fp-preview">
                {overdue.length ? overdue.map((p) => <div key={p.taskId} className="fp-small">{p.title} → <b>{p.label}</b></div>) : <div className="dim fp-small">Свободных окон в ближайшие дни нет.</div>}
                <div className="fp-acts">
                  {overdue.length > 0 && <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={working} onClick={() => void run(async () => { await focusApi.overdueApply(overdue); setOverdue(null); toastSaved('Разложено по дням', 'сроки задач не менялись'); onReload(); })}>Применить</button>}
                  <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setOverdue(null)}>Отмена</button>
                  <span className="dim fp-small">сроки не меняются — только время в календаре</span>
                </div>
              </div>
            )}
          </div>
        )}

        {!accepted && (
          <div className="fp-acts">
            <button type="button" className="ui-btn ui-btn-primary ui-btn-md" disabled={busy || working} onClick={() => void accept()}>Принять план</button>
            <button type="button" className="ui-btn ui-btn-outline ui-btn-md" onClick={onEdit}>Изменить</button>
            <button type="button" className="ui-btn ui-btn-outline ui-btn-md" disabled={busy} onClick={onRefresh}>Пересмотреть с ИИ</button>
            <button type="button" className="ui-btn ui-btn-ghost ui-btn-md" onClick={listen}><Icon name="play" size={13} /> Прослушать</button>
          </div>
        )}
        <button type="button" className="fp-link" aria-expanded={why} onClick={() => setWhy((v) => !v)}>Почему такой план</button>
        {why && (
          <div className="fp-why">
            {day.why.map((w) => (
              <div key={w.rank}><b>#{w.rank} {w.title}</b><div className="dim fp-small">{[...w.reasons, w.deadline].join(' · ')}</div></div>
            ))}
            {day.notIncluded.length > 0 && <div className="fp-small"><b>Не вошло в план:</b> {day.notIncluded.map((n) => `${n.title} — ${n.why}`).join('; ')}</div>}
          </div>
        )}
        {err && <div className="tv2-callout tv2-callout-danger" role="alert">{err}</div>}
      </div>
      <Timeline slots={day.timeline} onMoved={onReload} />
    </section>
  );
}

/** Таймлайн дня: задачи в свободных окнах между встречами; задачу можно перетащить на другое время. */
export function Timeline({ slots, onMoved }: { slots: DaySlot[]; onMoved: () => void }) {
  const [drag, setDrag] = useState<DaySlot | null>(null);
  const drop = async (target: DaySlot) => {
    if (!drag || !drag.taskId || drag === target) return;
    const len = Date.parse(drag.endsAt) - Date.parse(drag.startsAt);
    const start = Date.parse(target.startsAt);
    try {
      const body = { startsAt: new Date(start).toISOString(), endsAt: new Date(start + len).toISOString() };
      // у задачи уже есть блок на сегодня — двигаем его, второй не заводим
      const own = (await request<{ id: string; startsAt: string; endsAt: string }[]>('GET', `/calendar/blocks/task/${drag.taskId}`).catch(() => []))
        .find((b) => Date.parse(b.endsAt) > Date.now() && Date.parse(b.startsAt) < Date.now() + 86_400_000);
      if (own) await request('PATCH', `/calendar/blocks/${own.id}`, body);
      else await request('POST', '/calendar/blocks', { kind: 'task', taskId: drag.taskId, ...body });
      toastSaved('Перенесено', `${drag.title} — ${hm(new Date(start).toISOString())}`);
      onMoved();
    } catch (e) { toastSaved('Не получилось', e instanceof ApiError ? e.message : ''); }
    setDrag(null);
  };
  return (
    <aside className="fp-card fp-timeline" aria-label="Сегодня по часам">
      <div className="fp-title">Сегодня</div>
      {slots.map((s, i) => (
        <div key={`${s.kind}${i}`} className="fp-tl-row"
          onDragOver={(e) => { if (drag && s.kind === 'reserve') e.preventDefault(); }}
          onDrop={() => void drop(s)}>
          <span className="fp-tl-time dim">{hm(s.startsAt)}</span>
          <span className={`fp-tl-slot ${s.kind}`} draggable={s.kind === 'task'} onDragStart={() => setDrag(s)} onDragEnd={() => setDrag(null)}
            title={s.kind === 'task' ? 'Перетащите на резерв, чтобы перенести' : undefined}>
            <b>{s.kind === 'reviews' ? `Проверки и решения` : s.title}</b>
            <span className="dim fp-small">
              {s.kind === 'reviews' ? `${s.count} шт. · ${dur(Math.round((Date.parse(s.endsAt) - Date.parse(s.startsAt)) / 60000))}`
                : `${s.kind === 'task' ? 'глубокая работа · ' : ''}${s.estimated ? '≈ ' : ''}${dur(Math.round((Date.parse(s.endsAt) - Date.parse(s.startsAt)) / 60000))}`}
            </span>
          </span>
        </div>
      ))}
      {!slots.length && <div className="dim fp-small">Встреч и задач на сегодня нет.</div>}
      <div className="dim fp-small">блоки можно перетаскивать на резерв</div>
    </aside>
  );
}
