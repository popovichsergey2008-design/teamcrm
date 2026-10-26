/**
 * Быстрый ответ модели для того, кого человек ждёт на экране (#4666).
 *
 * Замер на проде 26.10: разбор голосовой задачи Kimi K3 (рассуждение «low») — 8–20 с
 * на вызов, а вызовов в постановке было до пяти подряд. Для короткой фразы это
 * неприемлемо: цель — задача за 6 секунд от отпускания кнопки.
 *
 * Поэтому быстрый путь: несколько быстрых моделей «внахлёст». Первая стартует сразу,
 * следующая — через `hedgeMs` или сразу после отказа предыдущей; кто первым вернул
 * непустой ответ, тот и прав, остальные отменяются. Общий потолок ставит вызывающий
 * сигналом: не успели — дальше работают правила, человек не ждёт.
 */
export interface HedgeRun {
  name: string;
  usedModel: string;
  run: (signal: AbortSignal) => Promise<string>;
}

export async function hedge(
  runs: HedgeRun[], hedgeMs: number, outer?: AbortSignal,
): Promise<{ text: string; usedModel: string; name: string }> {
  if (!runs.length) throw new Error('нет быстрых моделей');
  if (outer?.aborted) throw new Error('timeout');
  const ctrls = runs.map(() => new AbortController());
  const live = runs.map(() => false);
  const timers: NodeJS.Timeout[] = [];
  // отменяем только тех, кто ещё думает: ответивший уже ничего не держит
  const stopAll = () => { ctrls.forEach((c, i) => { if (live[i]) c.abort(); }); for (const t of timers) clearTimeout(t); };

  return new Promise((resolve, reject) => {
    let started = 0;
    let failed = 0;
    let settled = false;
    const errors: string[] = [];
    const finish = (fn: () => void) => { if (settled) return; settled = true; stopAll(); outer?.removeEventListener('abort', onOuter); fn(); };
    const onOuter = () => finish(() => reject(new Error('timeout')));
    outer?.addEventListener('abort', onOuter, { once: true });

    const launch = () => {
      if (settled || started >= runs.length) return;
      const i = started++;
      const r = runs[i];
      live[i] = true;
      // следующая модель — внахлёст, если эта задумалась
      if (started < runs.length) timers.push(setTimeout(launch, Math.max(0, hedgeMs)));
      r.run(ctrls[i].signal).then((text) => {
        live[i] = false;
        if (text && text.trim()) finish(() => resolve({ text, usedModel: r.usedModel, name: r.name }));
        else fail(`${r.name}: пустой ответ`);
      }, (e) => { live[i] = false; fail(`${r.name}: ${(e as Error)?.message ?? e}`); });
    };
    const fail = (why: string) => {
      if (settled) return;
      errors.push(why);
      failed += 1;
      if (failed >= runs.length) finish(() => reject(new Error(errors.join('; '))));
      else if (failed >= started) launch(); // все запущенные отказали — не ждём таймера
    };
    launch();
  });
}

/** Сигнал, который сработает через `ms` (и/или вместе с внешним). */
export function deadlineSignal(ms: number, outer?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new Error('timeout')), Math.max(0, ms));
  const onOuter = () => c.abort(new Error('timeout'));
  outer?.addEventListener('abort', onOuter, { once: true });
  return { signal: c.signal, cancel: () => { clearTimeout(t); outer?.removeEventListener('abort', onOuter); } };
}

/** Обещание с потолком: не успело — отказ «timeout» (само оно отменяется сигналом). */
export function rejectAfter<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('timeout'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}
