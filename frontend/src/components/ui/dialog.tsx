import { Dialog as Base } from '@base-ui/react/dialog';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { X } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { useState, type ReactNode } from 'react';
import { Button } from './button';
import { cn } from './cn';

/**
 * Окно поверх экрана (ТЗ-15). Фокус заперт внутри, Escape и щелчок мимо закрывают,
 * после закрытия фокус возвращается туда, откуда окно открыли, — всё это Base UI,
 * а не наш ручной код в каждом окне.
 */
export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'md' }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <Base.Root open={open} onOpenChange={onOpenChange}>
      <Base.Portal>
        <Base.Backdrop className="ui-backdrop" />
        <Base.Popup className={cn('ui-dialog', `ui-dialog-${size}`)}>
          <header className="ui-dialog-head">
            <Base.Title className="ui-dialog-title">{title}</Base.Title>
            <Base.Close className="ui-btn ui-btn-ghost ui-btn-icon-sm" aria-label="Закрыть"><X size={16} /></Base.Close>
          </header>
          {description && <Base.Description className="ui-dialog-desc">{description}</Base.Description>}
          {children && <div className="ui-dialog-body">{children}</div>}
          {footer && <footer className="ui-dialog-foot">{footer}</footer>}
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  );
}

/**
 * Подтверждение действия — вместо window.confirm.
 *
 * Системное окно на Android — серое и без названия приложения, а в браузере его можно
 * «запретить показывать», и тогда удаление молча проходит. По смыслу вызов тот же:
 *   if (!(await confirmAction({ title: 'Удалить задачу?', danger: true }))) return;
 */
export function confirmAction(opts: {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: boolean) => {
      resolve(v);
      // даём окну доиграть закрытие, потом убираем узел
      window.setTimeout(() => { root.unmount(); host.remove(); }, 200);
    };
    root.render(<ConfirmHost {...opts} onDone={done} />);
  });
}

/**
 * Вопрос с ответом текстом — вместо window.prompt («Что доработать?»).
 * Возвращает введённый текст или null, если человек передумал.
 */
export function promptText(opts: {
  title: string;
  description?: ReactNode;
  placeholder?: string;
  confirmLabel?: string;
  /** Короче — кнопка неактивна: «вернуть без причины» нельзя. */
  minLength?: number;
  /** Что стоит в поле сразу (как второй аргумент window.prompt). */
  defaultValue?: string;
  /** Одна строка (название, адрес): Enter — готово. По умолчанию — абзац, Ctrl+Enter. */
  singleLine?: boolean;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: string | null) => {
      resolve(v);
      window.setTimeout(() => { root.unmount(); host.remove(); }, 200);
    };
    root.render(<PromptHost {...opts} onDone={done} />);
  });
}

function PromptHost({ title, description, placeholder, confirmLabel, minLength = 1, defaultValue, singleLine, onDone }: {
  title: string; description?: ReactNode; placeholder?: string; confirmLabel?: string; minLength?: number;
  defaultValue?: string; singleLine?: boolean;
  onDone: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const [text, setText] = useState(defaultValue ?? '');
  const close = (v: string | null) => { if (!open) return; setOpen(false); onDone(v); };
  const ok = text.trim().length >= minLength;
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => { if (!o) close(null); }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="ui-backdrop" />
        <AlertDialog.Popup className="ui-dialog ui-dialog-sm">
          <AlertDialog.Title className="ui-dialog-title">{title}</AlertDialog.Title>
          {description && <AlertDialog.Description className="ui-dialog-desc">{description}</AlertDialog.Description>}
          {singleLine ? (
            <input
              className="ui-input ui-input-md"
              autoFocus
              placeholder={placeholder}
              value={text}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ok) { e.preventDefault(); close(text.trim()); } }}
            />
          ) : (
            <textarea
              className="ui-textarea"
              rows={4}
              autoFocus
              placeholder={placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && ok) close(text.trim()); }}
            />
          )}
          <footer className="ui-dialog-foot">
            <Button variant="ghost" onClick={() => close(null)}>Отмена</Button>
            <Button variant="primary" disabled={!ok} onClick={() => close(text.trim())}>{confirmLabel ?? 'Отправить'}</Button>
          </footer>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/**
 * Подпись красной кнопки по умолчанию — глагол из вопроса: «Отключить календарь?» →
 * «Отключить», «Выйти из группы?» → «Выйти». Кнопка «Удалить» под вопросом об
 * отключении читалась бы как другое, более страшное действие.
 */
function verbOf(title: string): string {
  const word = title.trim().split(/[\s?«»"]+/)[0] ?? '';
  return /ить$|ать$|ять$|еть$|ти$/.test(word) ? word : 'Удалить';
}

function ConfirmHost({ title, description, confirmLabel, cancelLabel, danger, onDone }: {
  title: string; description?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean;
  onDone: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const close = (v: boolean) => { if (!open) return; setOpen(false); onDone(v); };
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => { if (!o) close(false); }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="ui-backdrop" />
        <AlertDialog.Popup className="ui-dialog ui-dialog-sm">
          <AlertDialog.Title className="ui-dialog-title">{title}</AlertDialog.Title>
          {description && <AlertDialog.Description className="ui-dialog-desc">{description}</AlertDialog.Description>}
          <footer className="ui-dialog-foot">
            <Button variant="ghost" onClick={() => close(false)}>{cancelLabel ?? 'Отмена'}</Button>
            <Button variant={danger ? 'destructive' : 'primary'} onClick={() => close(true)} autoFocus>
              {confirmLabel ?? (danger ? verbOf(title) : 'Подтвердить')}
            </Button>
          </footer>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
