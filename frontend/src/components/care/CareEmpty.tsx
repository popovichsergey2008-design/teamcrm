import './care-empty.css';
import { Icon, IconName } from '../Icon';
import { openSupport } from '../support/SupportDock';

/**
 * Забота вместо пустоты (ТЗ-34 #4620, «Сегодня» п.3, п.6; Раздел 2 п.4).
 *
 * Тексты — дословно из документа заказчика, менять их нельзя без него. Кнопка —
 * одна, в один тап: просьба уходит в Службу заботы с пометкой, откуда пришла.
 *
 * Модуль ленивый (см. ./index.ts): на первый экран он не едет ни строкой, ни стилем.
 */
export type CareKind = 'tasks' | 'board' | 'rescue' | 'secretary' | 'chats' | 'team' | 'badge';

/** Событие для окна заботы: открыть и сразу отправить просьбу. */
export const CARE_REQUEST = 'qevo:care-request';

export function askCare(text: string, source: string): void {
  // Окно, которое умеет принять просьбу, гасит событие (preventDefault). Не погасило —
  // значит, слушателя ещё нет: хотя бы открываем окно заботы, чтобы тап не пропал.
  const handled = !window.dispatchEvent(new CustomEvent(CARE_REQUEST, { detail: { text, source }, cancelable: true }));
  if (!handled) openSupport();
}

const TASKS = {
  title: 'Перенесем ваши задачи и соберем проекты за 10 минут?',
  text: 'Не перепечатывайте задачи вручную! Скиньте в чат файл Excel, ссылку на доску Trello/Jira/Notion или просто перешлите сообщения из Telegram — наш инженер бесплатно создаст проекты, разложит задачи по срокам и назначит ответственных',
  button: 'Перенести задачи с инженером (ответ за 30 сек)',
};
const SECRETARY = {
  title: 'Хотите ставить задачи голосом за 3 секунды?',
  text: 'Нажмите кнопку — инженер Отдела заботы за 2 минуты свяжет вашего ИИ-секретаря с Telegram, настроит автосоздание поручений из голосовых сообщений и покажет, как делегировать рутину в 1 клик',
  button: 'Настроить ИИ-секретаря за меня',
};
const RESCUE = 'Подключить инженера в этот экран за 20 секунд — загрузим базу и настроим воронку за вас';
const CHATS = 'Помочь создать рабочие каналы по отделам и перенести команду из других мессенджеров? Инженер соберет всю структуру и разошлет приглашения за 5 минут';
const TRUST = 'Добавляйте новых участников в проекты за 5 секунд без ожидания оплаты банковских счетов — мы включаем доступы мгновенно на полном доверии';
const BADGE = 'Личный Отдел заботы 24/7 (ответ за 30 сек, видео-созвоны Huddle, бесплатный перенос задач и настройка проектов руками наших инженеров) уже включен в каждый тариф бесплатно';

function Card({ icon, title, text, button, source }: { icon: IconName; title: string; text: string; button: string; source: string }) {
  return (
    <section className="care-card">
      <span className="care-icon"><Icon name={icon} size={22} /></span>
      <h3 className="care-title">{title}</h3>
      <p className="care-text">{text}</p>
      <button type="button" className="ui-btn ui-btn-primary care-btn" onClick={() => askCare(button, source)}>
        <Icon name="support" size={16} /> {button}
      </button>
    </section>
  );
}

function Rescue({ source }: { source: string }) {
  return (
    <button type="button" className="care-rescue" onClick={() => askCare(RESCUE, source)}>
      <span className="care-rescue-dot" aria-hidden /> <Icon name="zap" size={16} /> {RESCUE}
    </button>
  );
}

function Badge() {
  return <p className="care-badge"><Icon name="check-circle" size={16} /> <span>{BADGE}</span></p>;
}

export function CareEmpty({ k }: { k: CareKind }) {
  const source = `empty:${k}`;
  if (k === 'tasks') return <div className="care-wrap"><Card icon="folder" source={source} {...TASKS} /></div>;
  if (k === 'board') {
    // пустой проект — та самая «пустая воронка»: карточка переноса и кнопка спасения по центру
    return <div className="care-wrap"><Card icon="board" source={source} {...TASKS} /><Rescue source={source} /></div>;
  }
  if (k === 'rescue') return <div className="care-wrap"><Rescue source={source} /></div>;
  if (k === 'secretary') return <div className="care-wrap"><Card icon="mic" source={source} {...SECRETARY} /></div>;
  if (k === 'chats') {
    return (
      <button type="button" className="care-plaque" onClick={() => askCare(CHATS, source)}>
        <Icon name="support" size={16} /> <span>{CHATS}</span>
      </button>
    );
  }
  if (k === 'team') {
    return (
      <div className="care-team">
        <p className="care-trust"><Icon name="user-plus" size={16} /> <span>{TRUST}</span></p>
        <Badge />
      </div>
    );
  }
  return <Badge />;
}
