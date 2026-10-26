import type { MouseEvent } from 'react';
import { LEGAL } from '../../legal';

/**
 * Галочка «Я принимаю Политику конфиденциальности» (#4675) — на всех формах, где
 * заводится аккаунт. Без неё кнопка регистрации неактивна, а сервер ответит 400.
 *
 * Ссылка — настоящая (`/legal/privacy`, новая вкладка по Ctrl/среднему клику), но
 * обычный щелчок открывает документ ОКНОМ поверх формы: заполненное не теряется, и в
 * приложении на телефоне не уводит во внешний браузер. Текст политики грузится лениво —
 * форма входа стоит в стартовой сборке.
 */
export function PolicyCheck({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const show = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    void import('./LegalOverlay').then((m) => m.openLegal('privacy')).catch(() => window.open(LEGAL.privacy.path, '_blank'));
  };
  return (
    <label className="policy-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} required />
      <span>
        Я принимаю{' '}
        <a href={LEGAL.privacy.path} target="_blank" rel="noopener" onClick={show}>Политику конфиденциальности</a>
      </span>
    </label>
  );
}
