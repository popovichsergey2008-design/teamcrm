import { useState } from 'react';
import './ai-plan.css';
import { Dialog } from './ui/dialog';
import { Select } from './ui/select';
import { api, ApiError } from '../lib/api';
import type { AiPlanCode, AiPlanStatus, PlatformTenant } from '../types';

const STATUS: { value: AiPlanStatus; label: string }[] = [
  { value: 'ACTIVE', label: 'Действует' },
  { value: 'TRIAL', label: 'Пробный' },
  { value: 'PAST_DUE', label: 'Ожидает оплаты (интернет выключен)' },
  { value: 'SUSPENDED', label: 'Приостановлен (интернет выключен)' },
  { value: 'CANCELLED', label: 'Отменён' },
];

/** Подпись тарифа в списке организаций консоли. */
export function aiPlanLabel(p: PlatformTenant['aiPlan']): string {
  if (!p) return 'не выбран';
  const name = p.plan === 'AI_EXTENDED' ? 'Расширенный' : 'Базовый';
  const st = p.status === 'TRIAL' ? ' (пробный)' : p.status === 'ACTIVE' ? '' : ` (${STATUS.find((s) => s.value === p.status)?.label.split(' (')[0].toLowerCase()})`;
  const web = p.plan === 'AI_EXTENDED' ? ` · ${p.webUsed}/${p.webCredits}` : '';
  return `${name}${st}${web}${p.upgradeRequestedAt && p.plan !== 'AI_EXTENDED' ? ' · просит «Расширенный»' : ''}`;
}

/**
 * Тариф ИИ организации из консоли вендора (ТЗ-33). Оплаты в продукте нет: тариф,
 * статус и интернет-лимит выставляются здесь — как договорились с клиентом.
 */
export function ConsoleAiPlanDialog({ tenant, onClose, onSaved }: { tenant: PlatformTenant; onClose: () => void; onSaved: () => void }) {
  const cur = tenant.aiPlan;
  const [plan, setPlan] = useState<AiPlanCode>(cur?.plan ?? 'AI_BASIC');
  const [status, setStatus] = useState<AiPlanStatus>(cur?.status ?? 'ACTIVE');
  const [credits, setCredits] = useState(String(cur?.webCredits ?? 300));
  const [trialDays, setTrialDays] = useState('14');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setBusy(true); setErr('');
    try {
      await api.platformSetAiPlan(tenant.id, {
        plan, status,
        webCredits: plan === 'AI_EXTENDED' ? Math.max(0, Number(credits) || 0) : 0,
        trialDays: status === 'TRIAL' ? Math.max(1, Number(trialDays) || 14) : undefined,
      });
      onSaved();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не сохранилось'); } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={`Тариф ИИ: ${tenant.name}`}
      footer={(
        <>
          <button className="ui-btn ui-btn-ghost ui-btn-md" onClick={onClose}>Отмена</button>
          <button className="ui-btn ui-btn-primary ui-btn-md" disabled={busy} onClick={() => void save()}>Сохранить</button>
        </>
      )}>
      <div className="projects-new-form">
        <label className="projects-new-field"><span>Тариф</span>
          <Select ariaLabel="Тариф" value={plan} onValueChange={(v) => setPlan(v as AiPlanCode)}
            options={[{ value: 'AI_BASIC', label: 'Базовый — ИИ только внутри CRM' }, { value: 'AI_EXTENDED', label: 'Расширенный — плюс интернет' }]} />
        </label>
        <label className="projects-new-field"><span>Статус</span>
          <Select ariaLabel="Статус тарифа" value={status} onValueChange={(v) => setStatus(v as AiPlanStatus)} options={STATUS} />
        </label>
        {plan === 'AI_EXTENDED' && (
          <label className="projects-new-field"><span>Интернет-запросов {status === 'TRIAL' ? 'на пробный период' : 'в месяц'}</span>
            <input className="input" inputMode="numeric" value={credits} onChange={(e) => setCredits(e.target.value.replace(/\D/g, ''))} />
          </label>
        )}
        {status === 'TRIAL' && (
          <label className="projects-new-field"><span>Дней пробного (с сегодняшнего)</span>
            <input className="input" inputMode="numeric" value={trialDays} onChange={(e) => setTrialDays(e.target.value.replace(/\D/g, ''))} />
          </label>
        )}
        {cur?.plan === 'AI_EXTENDED' && <div className="dim">В этом месяце израсходовано {cur.webUsed} из {cur.webCredits}.</div>}
        {err && <div className="error-text" role="alert">{err}</div>}
      </div>
    </Dialog>
  );
}
