import { useState, type MouseEvent } from 'react';
import { LEGAL } from '../../legal';

/** Документы сайта (#4680) — тексты живут на qevo.one, здесь только ссылки. */
const SITE = 'https://qevo.one/legal';

/**
 * Согласия при регистрации (#4675, #4680) — на всех формах, где заводится аккаунт.
 *
 * Как в форме сайта qevo.one, две галочки: условия оферты и соглашений с политикой и
 * отдельно — согласие на обработку персональных данных (по закону его дают отдельно).
 * `checked` — обе отмечены; без них кнопка регистрации неактивна, а сервер ответит 400.
 *
 * Политика конфиденциальности — своя страница `/legal/privacy`: щелчок открывает её окном
 * поверх формы, заполненное не теряется. Остальное — на сайте, в новой вкладке.
 */
export function PolicyCheck({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const [terms, setTerms] = useState(checked);
  const [pd, setPd] = useState(checked);
  const set = (t: boolean, p: boolean) => { setTerms(t); setPd(p); onChange(t && p); };
  const show = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    void import('./LegalOverlay').then((m) => m.openLegal('privacy')).catch(() => window.open(LEGAL.privacy.path, '_blank'));
  };
  const site = (path: string, text: string) => <a href={`${SITE}/${path}/`} target="_blank" rel="noopener">{text}</a>;
  return (
    <>
      <label className="policy-check">
        <input type="checkbox" checked={terms} onChange={(e) => set(e.target.checked, pd)} required />
        <span>
          Принимаю условия {site('offer', 'Публичной оферты')}, {site('terms', 'Пользовательского соглашения')},{' '}
          {site('license', 'Лицензионного соглашения')} и{' '}
          <a href={LEGAL.privacy.path} target="_blank" rel="noopener" onClick={show}>Политики конфиденциальности</a>
        </span>
      </label>
      <label className="policy-check">
        <input type="checkbox" checked={pd} onChange={(e) => set(terms, e.target.checked)} required />
        <span>Даю {site('consent', 'согласие на обработку моих персональных данных')}</span>
      </label>
    </>
  );
}
