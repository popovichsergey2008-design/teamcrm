import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { SkeletonList } from '../components/Skeleton';
import { openSupport } from '../components/support/SupportDock';
import { api } from '../lib/api';
import { consoleHref } from '../lib/router';
import { useAuth } from '../state/auth';
import type { SupportDesk } from '../types';

/**
 * Раздел «Служба заботы» — сторона того, кто обращается.
 *
 * Сам разговор живёт в панели поверх CRM; здесь то, что в панель не помещается:
 * состояние службы (кто на связи, за сколько отвечаем) и история своих обращений.
 *
 * Настроек здесь нет и не будет. ANTHILL — продукт, и службу заботы ведёт его
 * разработчик: очередь, дежурные, известные проблемы, сводка и справочник живут в
 * консоли техотдела по своему адресу (console.<домен>), и на основном домене её нет
 * даже в меню.
 * Раньше эта кухня была видна любому владельцу компании — для коробочного продукта
 * это неверно: клиент не настраивает нашу поддержку.
 *
 * Тяжёлой helpdesk-таблицы здесь тоже нет намеренно (ТЗ-8, разд. 22): человеку нужны
 * две вещи — «что было» и «открыть заново», а не колонки со статусами и приоритетами.
 */
export function SupportPage() {
  const { user } = useAuth();
  const [desk, setDesk] = useState<SupportDesk | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const d = await api.supportDesk().catch(() => null);
    if (d) setDesk(d);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const reopen = async (id: string) => {
    setBusy(true);
    try { await api.supportReopen(id); openSupport(); void load(); }
    finally { setBusy(false); }
  };

  const online = desk?.team.filter((t) => t.online) ?? [];
  const eta = desk?.etaSeconds;

  return (
    <div className="page">
      <div className="page-head">
        <h2 className="page-title"><Icon name="support" size={18} /> Служба заботы</h2>
        <div className="page-head-actions">
          {/*
            Единственный след консоли на основном домене — эта ссылка, и только у
            техотдела. В меню её нет намеренно: консоль живёт по своему адресу, и
            строка раздела на общих экранах наводила бы клиентов на лишние вопросы.
            Вход там отдельный: другой адрес — другое хранилище браузера.
          */}
          {user?.platformStaff && (
            <a className="btn btn-sm" href={consoleHref()} target="_blank" rel="noreferrer">
              <Icon name="lock" size={14} /> Консоль техподдержки
            </a>
          )}
          <button className="btn btn-primary btn-sm" onClick={() => openSupport()}>
            <Icon name="chat" size={15} /> Написать
          </button>
        </div>
      </div>

      <div className="support-page">
        {/*
          Состояние службы — первым делом и честными словами.

          «Среднее время ответа» показываем, только если есть по чему считать: цифра
          из воздуха здесь хуже её отсутствия (разд. 6).
        */}
        <div className="support-state">
          <div className="support-state-row">
            <span className={`support-state-dot${online.length ? ' on' : ''}`} aria-hidden="true" />
            <b>{online.length ? 'Специалисты на связи' : 'Дежурные сейчас офлайн'}</b>
            <span className="dim">
              {eta ? `обычно отвечаем за ${eta < 90 ? `${Math.round(eta / 10) * 10} сек` : `${Math.round(eta / 60)} мин`}` : 'ответим, как только освободимся'}
            </span>
          </div>
          {desk && desk.team.length > 0 && (
            <div className="support-team">
              {desk.team.map((t) => (
                <span key={t.userId} className={`support-person${t.online ? ' on' : ''}`} title={t.online ? 'на связи' : 'офлайн'}>
                  {t.name}
                  {!!t.skills.length && <span className="dim"> · {t.skills.join(', ')}</span>}
                </span>
              ))}
            </div>
          )}
          <p className="dim">
            Поддержка — живой разговор внутри CRM: сначала отвечает AnthillBot, он видит,
            на каком вы экране, и знает систему по справочнику ANTHILL. Не помог — одна
            кнопка, и подключится специалист. Контекст при этом не теряется, повторять
            ничего не придётся.
          </p>
        </div>

        <div className="support-block">
          <div className="drawer-section-title">Мои обращения</div>
          {!desk && <SkeletonList rows={3} />}
          {desk && !desk.history.length && (
            <EmptyState
              compact
              icon="support"
              title="Обращений пока не было"
              hint="Если что-то не работает или непонятно — напишите. Ответим в разговоре, без заявок и номеров."
            />
          )}
          {desk?.history.map((h) => (
            <div key={h.id} className="support-history-row">
              <div className="support-history-head">
                <b>{h.subject || 'Обращение'}</b>
                <span className="dim">{new Date(h.createdAt).toLocaleDateString('ru-RU')}</span>
              </div>
              <div className="dim support-history-sub">
                {h.statusText}
                {h.agentName ? ` · ${h.agentName}` : ''}
                {h.messages ? ` · сообщений: ${h.messages}` : ''}
                {h.csat ? ` · оценка ${h.csat}/4` : ''}
              </div>
              <div className="support-history-acts">
                <button className="btn btn-ghost btn-sm" onClick={() => openSupport()}>Открыть разговор</button>
                {h.closedAt && (
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void reopen(h.id)}>
                    Проблема снова появилась
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
