import { createRoot } from 'react-dom/client';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';

export type SeriesScope = 'one' | 'following' | 'all';

/**
 * Встреча из серии (#4787, п. 17): что менять — только эту, эту и последующие или всю серию.
 * null — человек передумал.
 */
export function askScope(action: 'save' | 'delete'): Promise<SeriesScope | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: SeriesScope | null) => {
      resolve(v);
      window.setTimeout(() => { root.unmount(); host.remove(); }, 200);
    };
    root.render(
      <Dialog open onOpenChange={(o) => { if (!o) done(null); }} size="sm"
        title={action === 'save' ? 'Изменить повторяющуюся встречу' : 'Удалить повторяющуюся встречу'}
        footer={<Button variant="ghost" onClick={() => done(null)}>Отмена</Button>}>
        <div className="cal-tt">
          <Button variant="outline" onClick={() => done('one')}>Только эту встречу</Button>
          <Button variant="outline" onClick={() => done('following')}>Эту и последующие</Button>
          <Button variant={action === 'delete' ? 'destructive' : 'primary'} onClick={() => done('all')}>Всю серию</Button>
        </div>
      </Dialog>,
    );
  });
}
