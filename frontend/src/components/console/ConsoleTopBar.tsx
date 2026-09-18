import { Avatar } from '../Avatar';
import { Icon } from '../Icon';
import { mainSiteHref } from '../../lib/router';

/**
 * Шапка консоли техотдела.
 *
 * Вместо левой панели CRM с двенадцатью разделами — одна строка: где я, кто я и как
 * выйти. Консоль — рабочее место одной задачи (разбирать обращения), и всё, что к ней
 * не относится, здесь только мешает.
 *
 * Ссылка «Открыть CRM» оставлена намеренно: сотруднику вендора иногда нужна обычная
 * система — своя доска, задача по багу из обращения. Она открывается на основном
 * домене отдельной вкладкой, а не подмешивается сюда разделами.
 */
export function ConsoleTopBar({
  name, avatarPath, onLogout,
}: {
  name: string;
  avatarPath: string | null;
  onLogout: () => void;
}) {
  return (
    <header className="console-bar">
      <span className="console-brand">
        <Icon name="lock" size={16} />
        <b>Служба заботы</b>
        <span className="dim">консоль техотдела</span>
      </span>
      <span className="console-bar-right">
        <a className="btn btn-ghost btn-sm" href={mainSiteHref()} target="_blank" rel="noreferrer">
          <Icon name="link" size={13} /> Открыть CRM
        </a>
        <span className="console-me">
          <Avatar path={avatarPath} fallback={name} className="avatar avatar-sm" />
          <span className="console-me-name">{name}</span>
        </span>
        <button className="btn btn-ghost btn-sm" onClick={onLogout} title="Выйти">
          <Icon name="logout" size={14} /> Выйти
        </button>
      </span>
    </header>
  );
}
