import { useEffect, useState } from 'react';
import './ai-demo-invite.css';
import { Icon } from './Icon';
import { Button } from './ui/button';
import { api } from '../lib/api';
import { navigate } from '../lib/router';

/**
 * Приглашение на демо «ИИ-созвон за 30 секунд» (ТЗ-24, §6): новичку на «Фокусе»,
 * пока он демо не проходил и не пропускал. Сервер решает, звать ли (§62): после
 * «Пропустить» или прохождения — молчим, демо остаётся в чек-листе.
 */
export default function AiDemoInvite() {
  const [show, setShow] = useState(false);
  useEffect(() => { api.aiDemoState().then((s) => setShow(s.invite)).catch(() => setShow(false)); }, []);
  if (!show) return null;
  return (
    <section className="aid-welcome" aria-label="Попробовать AI-созвон">
      <span className="aid-welcome-spark"><Icon name="sparkles" size={20} /></span>
      <span className="aid-welcome-text">
        <b>Протестировать магию AI-созвона за 30 секунд</b>
        <span className="dim">Скажите одну рабочую фразу — QEVO сам превратит её в задачи.</span>
      </span>
      <Button variant="primary" onClick={() => navigate('/onboarding/ai-call?from=welcome')}>
        <Icon name="mic" size={15} /> Попробовать AI-созвон
      </Button>
      <Button variant="ghost" size="sm" onClick={() => { setShow(false); void api.aiDemoSkip('welcome').catch(() => undefined); }}>
        Пропустить
      </Button>
    </section>
  );
}
