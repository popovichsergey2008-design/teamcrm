import { useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../Icon';
import { OptionSelect } from '../ui/option-select';
import { request, ApiError } from '../../lib/api';
import './org.css';

/**
 * Структура компании (#4615, доработка 23.10): «Кто руководит направлениями» и
 * оргсхема «кто кому подчиняется».
 *
 * Жалоба заказчика: «на мне и на Глебе программные задачи, но он всегда подставляет
 * Глеба» — руководители не были заданы, и подбор брал наименее загруженного. Здесь
 * это настраивается за минуту: направление → человек. По этой же структуре ИИ
 * понимает «поставь руководителю дизайна», «тимлиду фронта», «моему руководителю».
 */

export interface OrgPerson { id: string; name: string; positionName: string | null; level: string | null; skills: string[]; reportsTo: string | null; managerId: string | null }
export interface OrgDept { id: string; name: string; leadUserId: string | null; effectiveLeadId: string | null; deputyIds: string[]; memberIds: string[]; directions: string[]; parentId: string | null }
export interface OrgView {
  levels: { code: string; label: string }[];
  people: OrgPerson[];
  departments: OrgDept[];
  directions: { code: string; label: string; hasLead: boolean }[];
}

export const loadOrg = () => request<OrgView>('GET', '/org/structure');

const LEVEL_SHORT: Record<string, string> = {
  ceo: 'руководитель компании', head: 'руководитель отдела', deputy: 'тимлид', specialist: '', intern: 'стажёр',
};

/** Кто ведёт направление сейчас: руководитель отдела, где это направление отмечено. */
function leadOf(org: OrgView, code: string): { id: string; dept: string } | null {
  const d = org.departments
    .filter((x) => x.directions.includes(code) && x.effectiveLeadId)
    .sort((a, b) => a.directions.length - b.directions.length)[0];
  return d ? { id: String(d.effectiveLeadId), dept: d.name } : null;
}

export function OrgStructure({ org, onChanged }: { org: OrgView | null; onChanged: () => Promise<void> | void }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  if (!org) return <div className="dim">Загружаю структуру…</div>;

  const setLead = async (skill: string, userId: string) => {
    if (!userId) return;
    setBusy(skill); setErr('');
    try { await request('POST', '/org/direction-lead', { skill, userId }); await onChanged(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не сохранилось'); }
    finally { setBusy(''); }
  };

  const missing = org.directions.filter((d) => !d.hasLead);
  const byId = new Map(org.people.map((p) => [p.id, p]));
  const deptsOf = (id: string) => org.departments.filter((d) => d.memberIds.includes(id) || d.effectiveLeadId === id).map((d) => d.name);

  // Дерево «кто кому подчиняется»: без колец — кого не удалось разместить, ставим наверх
  const kids = new Map<string, OrgPerson[]>();
  const roots: OrgPerson[] = [];
  for (const p of org.people) {
    const boss = p.managerId && byId.has(p.managerId) && p.managerId !== p.id ? p.managerId : null;
    if (!boss) roots.push(p);
    else kids.set(boss, [...(kids.get(boss) ?? []), p]);
  }
  const placed = new Set<string>();
  const node = (p: OrgPerson, depth: number): ReactNode => {
    if (placed.has(p.id) || depth > 12) return null;
    placed.add(p.id);
    const children = (kids.get(p.id) ?? []).map((c) => node(c, depth + 1)).filter(Boolean);
    const role = LEVEL_SHORT[p.level ?? ''] ?? '';
    const deps = deptsOf(p.id);
    return (
      <li key={p.id}>
        <div className="org-node">
          <span className="org-name">{p.name}</span>
          <span className="org-meta">
            {[p.positionName, role && role !== (p.positionName ?? '').toLowerCase() ? role : '', deps.join(', ')].filter(Boolean).join(' · ') || 'должность не указана'}
          </span>
        </div>
        {children.length > 0 && <ul>{children}</ul>}
      </li>
    );
  };
  const tree = roots.map((p) => node(p, 0));
  // попали в кольцо «А подчиняется Б, Б — А» через отделы — показываем отдельно, а не теряем
  const rest = org.people.filter((p) => !placed.has(p.id)).map((p) => node(p, 0));

  return (
    <div className="org-wrap">
      <p className="dim org-rule">
        Кому QEVO ставит задачу: названному человеку или роли («тимлиду фронта», «моему руководителю»);
        иначе — руководителю направления задачи. Руководитель ставит сам — тимлиду или наименее
        загруженному специалисту своего отдела.
      </p>

      <section className="org-section" aria-labelledby="org-leads">
        <h4 id="org-leads" className="drawer-section-title">Кто руководит направлениями</h4>
        {missing.length > 0 && (
          <div className="tv2-callout tv2-callout-warn org-callout" role="note">
            <Icon name="alert" size={15} />
            <span>Без руководителя: {missing.map((d) => d.label).join(', ')}. Такие задачи сейчас уходят наименее загруженному.</span>
          </div>
        )}
        <div className="org-leads">
          {org.directions.map((d) => {
            const cur = leadOf(org, d.code);
            const fits = org.people.filter((p) => p.skills.includes(d.code) || (p.skills.includes('fullstack') && (d.code === 'backend' || d.code === 'frontend')));
            const others = org.people.filter((p) => !fits.includes(p));
            return (
              <label key={d.code} className="org-lead">
                <span className="org-lead-name">{d.label}</span>
                <OptionSelect
                  className="input"
                  value={cur?.id ?? ''}
                  disabled={busy === d.code}
                  aria-label={`Руководитель направления «${d.label}»`}
                  onChange={(e) => void setLead(d.code, e.target.value)}
                >
                  <option value="">не задан</option>
                  {fits.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  {others.map((p) => <option key={p.id} value={p.id}>{p.name} (другое направление)</option>)}
                </OptionSelect>
                {cur && <span className="dim org-lead-dept">отдел «{cur.dept}»</span>}
              </label>
            );
          })}
        </div>
        {err && <div className="error-text">{err}</div>}
      </section>

      <section className="org-section" aria-labelledby="org-tree">
        <h4 id="org-tree" className="drawer-section-title">Кто кому подчиняется</h4>
        <p className="dim org-hint">
          По умолчанию человек подчиняется руководителю своего отдела; руководитель отдела — руководителю
          вышестоящего отдела или компании. Поменять — во вкладке «Сотрудники», поле «Подчиняется».
        </p>
        <ul className="org-tree">{tree}{rest}</ul>
      </section>
    </div>
  );
}
