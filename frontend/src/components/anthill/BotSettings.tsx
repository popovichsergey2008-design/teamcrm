import { lazy, Suspense, useState } from 'react';
import { Icon } from '../Icon';
import type { AnthillSkill } from '../../lib/api';
import './bot-v3.css';

const AnthillSkills = lazy(() => import('./AnthillSkills').then((m) => ({ default: m.AnthillSkills })));
const AnthillMemory = lazy(() => import('./AnthillMemory').then((m) => ({ default: m.AnthillMemory })));
const AnthillResponses = lazy(() => import('./AnthillResponses').then((m) => ({ default: m.AnthillResponses })));
const AnthillAdmin = lazy(() => import('./AnthillAdmin').then((m) => ({ default: m.AnthillAdmin })));

type Section = 'skills' | 'memory' | 'responses' | 'admin';
const ABOUT: Record<Section, { title: string; sub: string }> = {
  skills: { title: 'Навыки', sub: 'Сценарии «как делать по-нашему». Бот берёт подходящий сам.' },
  memory: { title: 'Память', sub: 'Что бот помнит о вас и о работе — можно поправить или удалить.' },
  responses: { title: 'Быстрые ответы', sub: 'Готовые ответы от имени компании на частые вопросы.' },
  admin: { title: 'Права и лимиты', sub: 'Что боту позволено и сколько. Меняет владелец организации.' },
};

/**
 * «⋯ → Настройки бота» (#5035, п. 7): редкое — отдельным экраном с левым меню:
 * Навыки · Память · Быстрые ответы · Права и лимиты. Содержимое разделов прежнее.
 */
export default function BotSettings({ canManage, onBack, onRunSkill }: {
  canManage: boolean; onBack: () => void; onRunSkill: (s: AnthillSkill) => void;
}) {
  const [sec, setSec] = useState<Section>('skills');
  const list: Section[] = canManage ? ['skills', 'memory', 'responses', 'admin'] : ['skills', 'memory', 'admin'];
  return (
    <div className="bv-settings">
      <div className="bv-settings-head">
        <button type="button" className="bv-icon-btn" onClick={onBack} aria-label="Назад к боту" title="Назад"><Icon name="arrow-left" size={18} /></button>
        <span className="bv-settings-title"><b>Настройки бота</b><span>то, что нужно редко</span></span>
      </div>
      <div className="bv-settings-body">
        <nav className="bv-settings-nav" aria-label="Разделы настроек бота">
          {list.map((k) => (
            <button key={k} type="button" className={sec === k ? 'is-on' : ''} aria-current={sec === k ? 'page' : undefined} onClick={() => setSec(k)}>{ABOUT[k].title}</button>
          ))}
        </nav>
        <div className="bv-settings-main">
          <h2 className="bv-h">{ABOUT[sec].title}</h2>
          <p className="bv-sub">{ABOUT[sec].sub}</p>
          <Suspense fallback={<div className="dim">Загружаю…</div>}>
            {sec === 'skills' && <AnthillSkills onRun={onRunSkill} />}
            {sec === 'memory' && <AnthillMemory />}
            {sec === 'responses' && canManage && <AnthillResponses />}
            {sec === 'admin' && <AnthillAdmin />}
          </Suspense>
        </div>
      </div>
    </div>
  );
}
