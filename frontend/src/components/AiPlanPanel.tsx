import { useEffect, useState } from 'react';
import './ai-plan.css';
import { Icon } from './Icon';
import { SkeletonList } from './Skeleton';
import { Checkbox } from './ui/checkbox';
import { confirmAction } from './ui/dialog';
import { PlanCards } from './AiPlanChooser';
import { CareEmpty } from './care/CareEmpty';
import { api, ApiError } from '../lib/api';
import { navigate } from '../lib/router';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';
import type { AiPlanCode, AiPlanView } from '../types';

const num = (n: number) => n.toLocaleString('ru-RU');
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '');
const FEATURE: Record<string, string> = { web_search: 'Поиск в интернете', read_url: 'Чтение страниц по ссылке' };
const STATUS: Record<string, string> = {
  TRIAL: 'пробный', ACTIVE: 'действует', PAST_DUE: 'ожидает оплаты', SUSPENDED: 'приостановлен', CANCELLED: 'отменён',
};

/**
 * «Настройки → Тариф и ИИ» (ТЗ-33, §38–40): тариф, интернет-кредиты, расход CRM-ИИ,
 * жёсткий лимит, смена тарифа. Оплаты в продукте пока нет: «Перейти на Расширенный» —
 * заявка, тариф включает вендор; понизить владелец может сам.
 */
export function AiPlanPanel({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  useEscape(onClose);
  const [v, setV] = useState<AiPlanView | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.aiPlan().then(setV).catch((e) => setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить'));
  }, []);

  const run = async (fn: () => Promise<AiPlanView>) => {
    setBusy(true); setErr('');
    try { setV(await fn()); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); } finally { setBusy(false); }
  };

  const pick = async (code: AiPlanCode) => {
    if (!v) return;
    if (!v.selected) return run(() => api.aiPlanSelect(code));
    if (code === 'AI_EXTENDED') return run(() => api.aiPlanUpgrade());
    if (!(await confirmAction({
      title: 'Перейти на «Базовый»?',
      description: 'ИИ перестанет ходить в интернет сразу. Всё, что он уже нашёл и написал, останется, история расхода — тоже.',
      confirmLabel: 'Перейти на «Базовый»',
    }))) return;
    return run(() => api.aiPlanDowngrade());
  };

  const w = v?.web;
  const pct = w && w.limit > 0 ? Math.min(100, Math.round((w.used / w.limit) * 100)) : 0;

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="sparkles" size={18} /> Тариф и ИИ</h3>
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>

        {/* ТЗ-34 «Сегодня» п.6.1: забота включена в каждый тариф */}
        <CareEmpty k="badge" />

        {!v && !err && <SkeletonList rows={4} />}
        {err && <div className="error-text" role="alert">{err}</div>}

        {v && (
          <>
            <div className="drawer-section">
              <div className="drawer-section-title">Тариф</div>
              {v.selected ? (
                <div>
                  <b>«{v.planTitle}»</b> · {STATUS[v.status ?? ''] ?? v.status}
                  {v.status === 'TRIAL' && v.trialEndsAt && (v.trialExpired
                    ? <span className="error-text"> — пробный закончился {day(v.trialEndsAt)}, интернет выключен</span>
                    : <span className="dim"> до {day(v.trialEndsAt)}</span>)}
                </div>
              ) : (
                <div className="dim">Тариф ещё не выбран — сейчас ИИ работает как в «Базовом».</div>
              )}
              {v.upgradeRequestedAt && v.plan !== 'AI_EXTENDED' && (
                <div className="dim">Заявка на «Расширенный» отправлена {day(v.upgradeRequestedAt)} — мы свяжемся с вами.</div>
              )}
              <PlanCards current={v.plan} busy={busy || !canManage} onPick={canManage ? (c) => void pick(c) : undefined}
                pickLabel={(c) => (!v.selected ? `Выбрать «${c === 'AI_EXTENDED' ? 'Расширенный' : 'Базовый'}»`
                  : c === v.plan ? 'Текущий тариф'
                    : c === 'AI_EXTENDED' ? 'Перейти на «Расширенный»' : 'Перейти на «Базовый»')} />
            </div>

            {w && (v.plan === 'AI_EXTENDED' || w.used > 0) && (
              <div className="drawer-section">
                <div className="drawer-section-title">Интернет-ИИ · {v.status === 'TRIAL' ? 'за пробный период' : 'этот месяц'}</div>
                <div><b>{num(w.used)}</b> из {num(w.limit)} запросов{w.reserved ? ` · ещё ${w.reserved} выполняется` : ''}</div>
                <div className="aip-meter" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Израсходовано интернет-лимита">
                  <i style={{ width: `${pct}%` }} className={pct >= 100 ? 'aip-full' : pct >= 80 ? 'aip-warn' : ''} />
                </div>
                <div className="dim aip-note">
                  1 запрос — один поиск или одна прочитанная страница.
                  {w.forecast > w.used && ` При нынешнем темпе к концу периода — около ${num(w.forecast)} (оценка, не счёт).`}
                  {pct >= 100 && ' Интернет выключен до нового периода; ИИ внутри QEVO работает как обычно.'}
                </div>
                {canManage && (
                  <Checkbox
                    checked={w.hardLimit}
                    disabled={busy}
                    onCheckedChange={(on) => void run(() => api.aiLimits(on))}
                    label="Останавливать интернет-ИИ, когда лимит исчерпан (рекомендуется)"
                  />
                )}
                {v.byFeature.length > 0 && (
                  <>
                    <div className="drawer-section-title" style={{ marginTop: 10 }}>На что ушло</div>
                    {v.byFeature.map((f) => (
                      <div key={f.feature} className="aip-row"><span>{FEATURE[f.feature] ?? f.feature}</span><b>{num(f.credits)}</b></div>
                    ))}
                  </>
                )}
                {v.byUser.length > 0 && (
                  <>
                    <div className="drawer-section-title" style={{ marginTop: 10 }}>Кто запрашивал</div>
                    {v.byUser.map((u) => (
                      <div key={u.user_id} className="aip-row"><span>{u.name}</span><b>{num(u.credits)}</b></div>
                    ))}
                    <div className="dim aip-note">Чтобы понять, куда ушёл лимит, — не оценка работы людей.</div>
                  </>
                )}
              </div>
            )}

            <div className="drawer-section">
              <div className="drawer-section-title">ИИ внутри QEVO · этот месяц</div>
              <div>{num(v.internal.calls)} обращений · {num(v.internal.tokens)} токенов</div>
              <div className="aip-acts">
                <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => navigate({ section: 'settings', tab: 'ai-usage' })}>
                  Подробно: где и сколько <Icon name="chevron-right" size={13} />
                </button>
              </div>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
