import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleCheck, CircleHelp, CircleX, FileDown, GitCompareArrows, ImageOff, Link2, RefreshCw, ScanEye } from 'lucide-react';
import { api, ApiError, request, tokens } from '../../lib/api';
import { apiUrl } from '../../lib/origin';
import { buildPath } from '../../lib/router';
import { showToast, toastSaved } from '../../lib/notifications';
import { platform } from '../../platform';
import { AuthedMedia } from '../AuthedMedia';
import { Lightbox, type LightboxItem } from '../Lightbox';
import { Badge, type BadgeTone } from '../ui/badge';
import { Button } from '../ui/button';
import { promptText } from '../ui/dialog';
import { Select } from '../ui/select';
import './before-after.css';

/*
  Вкладка «Было/стало» (#4657).

  Отдельным куском и со своим CSS: карточка задачи открывается часто, а отчёт смотрят
  после сдачи — тянуть его вёрстку в каждую карточку незачем.

  Вид — как образец заказчика: номер в кружке, название пункта, строка «Было → Стало»,
  две колонки БЫЛО (терракотовая подпись) и СТАЛО (синяя). На телефоне колонки идут
  друг под другом. Снимки — общий Lightbox: листать и увеличивать, как в чате.
*/

type Verdict = 'fixed' | 'not_fixed' | 'unclear' | 'no_result' | 'eyes';
interface Shot {
  fileId: string; name: string; mime: string; by: string | null; at: string | null;
  origin: 'description' | 'attachment' | 'comment' | 'page'; caption?: string | null; url?: string | null;
}
interface CheckItem {
  n: number; title: string; detail: string | null; done: boolean | null;
  change: { from: string | null; to: string | null } | null;
  before: Shot[]; after: Shot[]; verdict: Verdict; reason: string;
}
interface Summary {
  total?: number; fixed?: number; notFixed?: number; check?: number; noResult?: number;
  headline?: string; message?: string; notes?: string[]; modelSummary?: string;
  loose?: { before?: Shot[]; after?: Shot[] };
}
interface Report {
  id: string; version: number; status: 'running' | 'ready' | 'failed'; trigger: 'manual' | 'auto';
  requestedBy: string | null; createdAt: string; finishedAt: string | null;
  mode: 'ai' | 'eyes'; model: string | null; items: CheckItem[]; summary: Summary; error: string | null;
}
interface Overview {
  task: { id: string; title: string; projectId: string; approvalPending: boolean; canDecide: boolean; isCreator: boolean; closed: boolean };
  versions: { id: string; version: number; status: Report['status']; trigger: Report['trigger']; createdAt: string; requestedBy: string | null }[];
  current: Report | null;
  changed: boolean | null;
  materials: { before: number; after: number; messages: number };
}

const baApi = {
  overview: (taskId: string) => request<Overview>('GET', `/tasks/${taskId}/before-after`),
  get: (taskId: string, id: string) => request<Report>('GET', `/tasks/${taskId}/before-after/${id}`),
  run: (taskId: string) => request<{ report: Report; unchanged: boolean }>('POST', `/tasks/${taskId}/before-after`, {}),
  /** PDF — файл, а не JSON: мимо общего конверта. */
  pdf: async (taskId: string, id: string): Promise<Blob> => {
    const res = await fetch(apiUrl(`/api/tasks/${taskId}/before-after/${id}/pdf`), {
      headers: tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {},
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new ApiError(body?.error?.code ?? 'INTERNAL', body?.error?.message ?? `Не удалось собрать PDF (${res.status})`);
    }
    return res.blob();
  },
};

const VERDICT: Record<Verdict, { label: string; tone: BadgeTone; Icon: typeof CircleCheck }> = {
  fixed: { label: 'Исправлено', tone: 'ok', Icon: CircleCheck },
  not_fixed: { label: 'Не исправлено', tone: 'danger', Icon: CircleX },
  no_result: { label: 'Результат не приложен', tone: 'danger', Icon: ImageOff },
  unclear: { label: 'Не удалось проверить', tone: 'warn', Icon: CircleHelp },
  eyes: { label: 'Проверьте глазами', tone: 'warn', Icon: ScanEye },
};

const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Замечания по невнесённым пунктам — тем же текстом, что сервер пишет в обсуждение. */
function remarks(items: CheckItem[]): string {
  const bad = items.filter((i) => i.verdict === 'not_fixed' || i.verdict === 'no_result');
  if (!bad.length) return '';
  return ['По отчёту «было/стало» не внесены правки:', ...bad.map((i) => `${i.n}. ${i.title}${i.reason ? ` — ${i.reason}` : ''}`)].join('\n');
}

export default function BeforeAfterTab({ taskId, projectId, autoRun, onAutoRunDone, onRefresh }: {
  taskId: string;
  projectId: string;
  /** Пришли из меню «⋯ → Проверить было/стало»: запускаем сразу. */
  autoRun?: boolean;
  onAutoRunDone?: () => void;
  onRefresh: () => void;
}) {
  const [data, setData] = useState<Overview | null>(null);
  const [shown, setShown] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<'' | 'run' | 'pdf' | 'decide'>('');
  const [light, setLight] = useState<{ items: LightboxItem[]; index: number } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const o = await baApi.overview(taskId);
      if (!alive.current) return null;
      setData(o);
      // выбранная руками старая версия остаётся на экране; иначе — последняя
      setShown((cur) => (cur && cur.id !== o.current?.id && o.versions.some((v) => v.id === cur.id) ? cur : o.current));
      return o;
    } catch (e) {
      if (alive.current) setErr(e instanceof ApiError ? e.message : 'Не удалось загрузить отчёт');
      return null;
    }
  }, [taskId]);

  useEffect(() => { void load(); }, [load]);

  // идёт проверка — спрашиваем, не готова ли
  const running = data?.current?.status === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const t = window.setInterval(() => { void load(); }, 2500);
    return () => window.clearInterval(t);
  }, [running, load]);

  const run = useCallback(async () => {
    setErr(''); setBusy('run');
    try {
      const r = await baApi.run(taskId);
      if (r.unchanged) showToast({ title: 'Ничего не изменилось', body: 'С прошлой проверки материалы те же — показываю её отчёт', section: 'focus' });
      setShown(r.report);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось запустить проверку');
    } finally { if (alive.current) setBusy(''); }
  }, [taskId, load]);

  const ranAuto = useRef(false);
  useEffect(() => {
    if (!autoRun || ranAuto.current || !data) return;
    ranAuto.current = true;
    onAutoRunDone?.();
    if (data.current?.status !== 'running') void run();
  }, [autoRun, data, run, onAutoRunDone]);

  const pickVersion = async (id: string) => {
    if (id === shown?.id) return;
    try { setShown(await baApi.get(taskId, id)); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось открыть версию'); }
  };

  const downloadPdf = async () => {
    if (!shown) return;
    setBusy('pdf'); setErr('');
    try {
      const blob = await baApi.pdf(taskId, shown.id);
      await platform.filesystem.save(`Было-стало — задача ${taskId}, версия ${shown.version}.pdf`, blob);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось собрать PDF — попробуйте ещё раз');
    } finally { setBusy(''); }
  };

  const copyLink = () => {
    const url = `${window.location.origin}${buildPath({ section: 'projects', projectId, taskId, view: 'check' })}`;
    navigator.clipboard?.writeText(url).then(() => toastSaved('Ссылка скопирована', 'Откроет задачу сразу на «Было/стало»')).catch(() => undefined);
  };

  /** Принять / вернуть — те же действия, что в карточке, а замечания уже собраны отчётом. */
  const decide = async (accept: boolean) => {
    if (!shown) return;
    setErr('');
    try {
      if (accept) {
        setBusy('decide');
        await api.approveTask(taskId);
        toastSaved('Работа принята');
      } else {
        const reason = await promptText({
          title: 'Вернуть на доработку',
          description: 'Замечания уйдут исполнителю и останутся в истории задачи.',
          defaultValue: remarks(shown.items),
          placeholder: 'Что доработать',
          confirmLabel: 'Вернуть',
          minLength: 3,
        });
        if (!reason?.trim()) return;
        setBusy('decide');
        await api.returnTask(taskId, reason.trim());
        toastSaved('Возвращено на доработку');
      }
      onRefresh();
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не получилось');
    } finally { if (alive.current) setBusy(''); }
  };

  /** Не на согласовании — замечания сообщением в обсуждение задачи. */
  const sendRemarks = async () => {
    if (!shown) return;
    const text = await promptText({
      title: 'Замечания исполнителю',
      description: 'Сообщение уйдёт в обсуждение задачи.',
      defaultValue: remarks(shown.items),
      confirmLabel: 'Отправить',
      minLength: 3,
    });
    if (!text?.trim()) return;
    try {
      await api.addComment(taskId, text.trim());
      window.dispatchEvent(new CustomEvent('teamcrm:task-chat-reload', { detail: { taskId } }));
      toastSaved('Замечания отправлены');
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось отправить'); }
  };

  /** Все снимки отчёта по порядку — Lightbox листает их стрелками. */
  const allShots = useMemo(() => {
    if (!shown) return [] as Shot[];
    const loose = shown.summary.loose ?? {};
    const seen = new Set<string>();
    return [...shown.items.flatMap((i) => [...i.before, ...i.after]), ...(loose.before ?? []), ...(loose.after ?? [])]
      .filter((s) => (seen.has(s.fileId) ? false : (seen.add(s.fileId), true)));
  }, [shown]);
  const open = (s: Shot) => {
    const items = allShots.map((x) => ({ fileId: x.fileId, name: x.name, mime: x.mime }));
    setLight({ items, index: Math.max(0, allShots.findIndex((x) => x.fileId === s.fileId)) });
  };

  if (!data && !err) return <div className="ba-loading" aria-busy="true"><span className="media-skeleton" /></div>;

  const s = shown?.summary ?? {};
  const problems = (s.notFixed ?? 0) + (s.noResult ?? 0);
  const tone = shown?.status !== 'ready' ? 'neutral' : problems ? 'danger' : (s.check ?? 0) ? 'warn' : 'ok';
  const canRemark = shown?.status === 'ready' && problems > 0;
  const isLatest = shown && data?.current && shown.id === data.current.id;

  return (
    <div className="ba">
      <div className="ba-head">
        <div className="ba-head-text">
          <h3 className="ba-title"><GitCompareArrows size={18} aria-hidden /> Было/стало</h3>
          <p className="ba-lead">Слева — исходные материалы и замечания, справа — результат исполнителя.</p>
        </div>
        <div className="ba-actions">
          {data && data.versions.length > 1 && (
            <Select
              size="sm"
              ariaLabel="Версия отчёта"
              value={shown?.id ?? ''}
              onValueChange={(v) => void pickVersion(v)}
              options={data.versions.map((v) => ({
                value: v.id,
                label: `Версия ${v.version} · ${when(v.createdAt)} · ${v.trigger === 'auto' ? 'автоматически' : v.requestedBy ?? 'вручную'}`,
              }))}
            />
          )}
          {shown?.status === 'ready' && (
            <>
              <Button variant="ghost" size="sm" onClick={copyLink} title="Ссылка откроет задачу сразу на этой вкладке">
                <Link2 size={15} aria-hidden /> Ссылка
              </Button>
              <Button variant="outline" size="sm" onClick={() => void downloadPdf()} loading={busy === 'pdf'} title="PDF с теми же снимками — переслать или распечатать">
                {busy !== 'pdf' && <FileDown size={15} aria-hidden />} PDF
              </Button>
            </>
          )}
          <Button variant="primary" size="sm" onClick={() => void run()} loading={busy === 'run' || running} disabled={running}>
            {busy !== 'run' && !running && <RefreshCw size={15} aria-hidden />} {running ? 'Проверяю…' : 'Проверить было/стало'}
          </Button>
        </div>
      </div>

      {err && <div className="tv2-callout tv2-callout-danger" role="alert">{err}</div>}
      {data?.changed && isLatest && !running && (
        <div className="tv2-callout tv2-callout-info">После этой проверки в задаче появились новые материалы — проверьте заново.</div>
      )}

      {!shown && !running && (
        <div className="ba-empty">
          <GitCompareArrows size={28} aria-hidden />
          <p className="ba-empty-title">Отчёта пока нет</p>
          <p className="ba-empty-hint">
            Система разложит задачу по пунктам правок и поставит рядом снимки «было» и «стало».
            {' '}Сейчас в задаче: снимков «было» — {data?.materials.before ?? 0}, «стало» — {data?.materials.after ?? 0}.
            {' '}После сдачи на проверку отчёт соберётся сам.
          </p>
        </div>
      )}

      {shown?.status === 'running' && (
        <div className="ba-running" role="status">
          <span className="ba-pulse" aria-hidden /> Сравниваю «было» и «стало» — это займёт до минуты. Можно закрыть карточку: отчёт сохранится.
        </div>
      )}
      {shown?.status === 'failed' && (
        <div className="tv2-callout tv2-callout-danger" role="alert">{shown.error ?? 'Проверка не удалась'} — нажмите «Проверить было/стало» ещё раз.</div>
      )}

      {shown?.status === 'ready' && (
        <>
          <div className={`ba-total ba-total-${tone}`}>
            <strong className="ba-total-head">{s.headline}</strong>
            <span>{s.message}</span>
            {(s.notes ?? []).map((n) => <span key={n} className="ba-note">{n}</span>)}
            <span className="ba-note">
              Версия {shown.version} · {when(shown.createdAt)} · {shown.trigger === 'auto' ? 'проверено после сдачи' : `запустил ${shown.requestedBy ?? '—'}`}
              {shown.mode === 'ai' && shown.model ? ` · сравнивала модель ${shown.model}` : ''}. Это помощь глазам, а не приёмка работы.
            </span>
            {isLatest && (data?.task.canDecide || canRemark) && (
              <div className="ba-decide">
                {data?.task.canDecide ? (
                  <>
                    <Button variant="primary" size="sm" onClick={() => void decide(true)} loading={busy === 'decide'}>Принять</Button>
                    <Button variant="outline" size="sm" onClick={() => void decide(false)} disabled={busy === 'decide'}>Вернуть на доработку</Button>
                  </>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => void sendRemarks()}>Написать замечания исполнителю</Button>
                )}
              </div>
            )}
          </div>

          <ol className="ba-items">
            {shown.items.map((it) => {
              const v = VERDICT[it.verdict] ?? VERDICT.eyes;
              return (
                <li key={it.n} className="ba-item">
                  <div className="ba-item-head">
                    <span className="ba-num" aria-hidden>{it.n}</span>
                    <h4 className="ba-item-title"><span className="ba-sr">Пункт {it.n}. </span>{it.title}</h4>
                    <Badge tone={v.tone} className="ba-verdict"><v.Icon size={12} aria-hidden /> {v.label}</Badge>
                  </div>
                  {it.change && (it.change.from || it.change.to) && (
                    <p className="ba-change">
                      Было: «{it.change.from ?? '—'}» → Стало: {it.change.to ? `«${it.change.to}»` : 'убрано'}
                    </p>
                  )}
                  {it.detail && <p className="ba-detail">{it.detail}</p>}
                  {it.reason && <p className="ba-reason">{it.reason}</p>}
                  <div className="ba-cols">
                    <Column side="before" shots={it.before} onOpen={open}
                      empty={it.change?.from ? `Скриншота «до» не было — показан прежний текст: «${it.change.from}»` : 'Скриншота «до» нет'} />
                    <Column side="after" shots={it.after} onOpen={open} empty="Результат не приложен" />
                  </div>
                </li>
              );
            })}
          </ol>

          {((s.loose?.before?.length ?? 0) + (s.loose?.after?.length ?? 0)) > 0 && (
            <section className="ba-item ba-loose">
              <div className="ba-item-head"><h4 className="ba-item-title">Снимки без привязки к пункту</h4></div>
              <div className="ba-cols">
                <Column side="before" shots={s.loose?.before ?? []} onOpen={open} empty="—" />
                <Column side="after" shots={s.loose?.after ?? []} onOpen={open} empty="—" />
              </div>
            </section>
          )}
        </>
      )}

      {light && <Lightbox items={light.items} index={light.index} onClose={() => setLight(null)} />}
    </div>
  );
}

function Column({ side, shots, empty, onOpen }: { side: 'before' | 'after'; shots: Shot[]; empty: string; onOpen: (s: Shot) => void }) {
  return (
    <div className="ba-col">
      <div className={`ba-label ba-label-${side}`}>{side === 'before' ? 'Было' : 'Стало'}</div>
      {shots.length ? shots.map((s) => (
        <figure key={s.fileId} className="ba-shot">
          <div className="ba-shot-frame">
            <AuthedMedia fileId={s.fileId} name={s.name} mime={s.mime} className="ba-img" onOpen={() => onOpen(s)} />
          </div>
          <figcaption className="ba-cap">
            {[s.origin === 'page' ? 'Снимок страницы' : s.by, s.at ? when(s.at) : null].filter(Boolean).join(' · ')}
            {s.caption && s.origin !== 'page' && <span className="ba-cap-text"> — {s.caption}</span>}
            {s.url && <> — <a href={s.url} target="_blank" rel="noreferrer noopener">{s.url}</a></>}
          </figcaption>
        </figure>
      )) : <div className="ba-none">{empty}</div>}
    </div>
  );
}
