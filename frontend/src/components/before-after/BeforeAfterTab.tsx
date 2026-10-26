import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleCheck, CircleHelp, CircleX, FileDown, GitCompareArrows, ImageOff, Link2, ListChecks, RefreshCw, ScanEye, Send } from 'lucide-react';
import { api, ApiError, request, tokens } from '../../lib/api';
import { apiUrl } from '../../lib/origin';
import { buildPath } from '../../lib/router';
import { showToast, toastSaved } from '../../lib/notifications';
import { platform } from '../../platform';
import { AuthedMedia } from '../AuthedMedia';
import { Lightbox, type LightboxItem } from '../Lightbox';
import { Badge, type BadgeTone } from '../ui/badge';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
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

  Доработка по жалобе заказчика («скрины давались как пример, а он думает, что это
  „было“»): у каждого снимка — роль. Образец постановщика показываем отдельно, а не в
  «Было»; роль можно поправить руками и пересобрать отчёт. Если пункты — критерии
  приёмки функции, отчёт — чек-лист приёмки: без требования скринов «стало», с
  отметками «Проверено» для постановщика.
*/

type Verdict = 'fixed' | 'not_fixed' | 'unclear' | 'no_result' | 'eyes';
type Role = 'before' | 'example' | 'reference' | 'after' | 'none';
type ManualRole = 'before' | 'example' | 'after' | 'none';
interface Shot {
  fileId: string; name: string; mime: string; by: string | null; at: string | null;
  origin: 'description' | 'attachment' | 'comment' | 'page'; caption?: string | null; url?: string | null;
  role?: Role; roleBy?: 'rule' | 'model' | 'manual';
}
interface CheckItem {
  n: number; title: string; detail: string | null; done: boolean | null;
  change: { from: string | null; to: string | null } | null;
  before: Shot[]; after: Shot[]; verdict: Verdict; reason: string;
}
interface Mark { by?: string; at?: string }
interface Summary {
  total?: number; fixed?: number; notFixed?: number; check?: number; noResult?: number;
  headline?: string; message?: string; notes?: string[]; modelSummary?: string;
  loose?: { before?: Shot[]; after?: Shot[] };
  kind?: 'visual' | 'functional';
  examples?: Shot[]; others?: Shot[];
  afterReport?: { author: string | null; at: string | null; body: string }[];
  checked?: Record<string, Mark>;
  askedResult?: Mark;
}
interface Report {
  id: string; version: number; status: 'running' | 'ready' | 'failed'; trigger: 'manual' | 'auto';
  requestedBy: string | null; createdAt: string; finishedAt: string | null;
  mode: 'ai' | 'eyes'; model: string | null; items: CheckItem[]; summary: Summary; error: string | null;
}
interface Overview {
  task: {
    id: string; title: string; projectId: string; approvalPending: boolean; canDecide: boolean; isCreator: boolean; closed: boolean;
    canSetRoles?: boolean; canCheck?: boolean; canAsk?: boolean;
  };
  versions: { id: string; version: number; status: Report['status']; trigger: Report['trigger']; createdAt: string; requestedBy: string | null }[];
  current: Report | null;
  changed: boolean | null;
  materials: { before: number; after: number; examples?: number; messages: number };
  roles?: Record<string, ManualRole>;
}

const baApi = {
  overview: (taskId: string) => request<Overview>('GET', `/tasks/${taskId}/before-after`),
  get: (taskId: string, id: string) => request<Report>('GET', `/tasks/${taskId}/before-after/${id}`),
  run: (taskId: string) => request<{ report: Report; unchanged: boolean }>('POST', `/tasks/${taskId}/before-after`, {}),
  setRole: (taskId: string, fileId: string, role: ManualRole | null) =>
    request<{ fileId: string; role: ManualRole | null }>('PUT', `/tasks/${taskId}/before-after/shots/${fileId}`, { role }),
  askResult: (taskId: string, id: string) => request<{ sent: boolean }>('POST', `/tasks/${taskId}/before-after/${id}/ask-result`, {}),
  setChecked: (taskId: string, id: string, n: number, checked: boolean) =>
    request<Report>('PUT', `/tasks/${taskId}/before-after/${id}/checked`, { n, checked }),
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
  no_result: { label: 'Результат не приложен', tone: 'warn', Icon: ImageOff },
  unclear: { label: 'Стоит посмотреть', tone: 'warn', Icon: CircleHelp },
  eyes: { label: 'Проверьте глазами', tone: 'warn', Icon: ScanEye },
};
/** В чек-листе приёмки — не «исправлено», а «подтверждено». */
const FUNCTIONAL_LABEL: Partial<Record<Verdict, string>> = {
  fixed: 'Подтверждено', not_fixed: 'Не выполнено', no_result: 'Нет отчёта исполнителя', eyes: 'Проверьте сами',
};

const ROLE_OPTIONS: { value: ManualRole; label: string }[] = [
  { value: 'before', label: 'Было' },
  { value: 'example', label: 'Образец' },
  { value: 'after', label: 'Стало' },
  { value: 'none', label: 'Не относится' },
];

const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Замечания по невнесённым пунктам — тем же текстом, что сервер пишет в обсуждение. */
function remarks(items: CheckItem[]): string {
  const bad = items.filter((i) => i.verdict === 'not_fixed' || i.verdict === 'no_result');
  if (!bad.length) return '';
  const head = bad.some((i) => i.verdict === 'not_fixed')
    ? 'По отчёту «было/стало» не внесены правки:'
    : 'По отчёту «было/стало» нет результата по пунктам:';
  return [head, ...bad.map((i) => `${i.n}. ${i.title}${i.reason ? ` — ${i.reason}` : ''}`)].join('\n');
}

/** Роль снимка в переключателе: ручная (если уже выбрана) или та, что в отчёте. */
function shownRole(s: Shot, fallback: ManualRole, manual: Record<string, ManualRole>): ManualRole {
  const m = manual[s.fileId];
  if (m) return m;
  if (s.role === 'reference') return 'none';
  return (s.role as ManualRole | undefined) ?? fallback;
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
  const [busy, setBusy] = useState<'' | 'run' | 'pdf' | 'decide' | 'ask'>('');
  const [light, setLight] = useState<{ items: LightboxItem[]; index: number } | null>(null);
  /** Роли, поставленные руками, — сразу видны в переключателе, до пересборки отчёта. */
  const [manual, setManual] = useState<Record<string, ManualRole>>({});
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const o = await baApi.overview(taskId);
      if (!alive.current) return null;
      setData(o);
      setManual(o.roles ?? {});
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

  /** «Попросить результат» — одно сообщение исполнителю; повторное нажатие его не дублирует. */
  const askResult = async () => {
    if (!shown) return;
    setErr(''); setBusy('ask');
    try {
      const r = await baApi.askResult(taskId, shown.id);
      window.dispatchEvent(new CustomEvent('teamcrm:task-chat-reload', { detail: { taskId } }));
      if (r.sent) toastSaved('Попросили результат', 'Сообщение исполнителю — в обсуждении задачи');
      else showToast({ title: 'Уже просили', body: 'Сообщение исполнителю уже есть в обсуждении — второй раз не пишем', section: 'focus' });
      const fresh = await baApi.get(taskId, shown.id);
      if (alive.current) setShown(fresh);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось отправить');
    } finally { if (alive.current) setBusy(''); }
  };

  const setRole = async (s: Shot, role: ManualRole) => {
    const prev = manual;
    setManual({ ...manual, [s.fileId]: role });
    try {
      await baApi.setRole(taskId, s.fileId, role);
      const o = await baApi.overview(taskId);
      if (alive.current) setData(o);
    } catch (e) {
      if (alive.current) { setManual(prev); setErr(e instanceof ApiError ? e.message : 'Не удалось поменять роль снимка'); }
    }
  };

  const toggleChecked = async (n: number, checked: boolean) => {
    if (!shown) return;
    try {
      const r = await baApi.setChecked(taskId, shown.id, n, checked);
      if (alive.current) setShown(r);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось отметить пункт'); }
  };

  /** Все снимки отчёта по порядку — Lightbox листает их стрелками. */
  const allShots = useMemo(() => {
    if (!shown) return [] as Shot[];
    const sm = shown.summary;
    const loose = sm.loose ?? {};
    const seen = new Set<string>();
    return [
      ...(sm.examples ?? []), ...shown.items.flatMap((i) => [...i.before, ...i.after]),
      ...(loose.before ?? []), ...(loose.after ?? []), ...(sm.others ?? []),
    ].filter((s) => (seen.has(s.fileId) ? false : (seen.add(s.fileId), true)));
  }, [shown]);
  const open = (s: Shot) => {
    const items = allShots.map((x) => ({ fileId: x.fileId, name: x.name, mime: x.mime }));
    setLight({ items, index: Math.max(0, allShots.findIndex((x) => x.fileId === s.fileId)) });
  };

  if (!data && !err) return <div className="ba-loading" aria-busy="true"><span className="media-skeleton" /></div>;

  const s = shown?.summary ?? {};
  const functional = s.kind === 'functional';
  const notFixed = s.notFixed ?? 0;
  const noResult = s.noResult ?? 0;
  const tone = shown?.status !== 'ready' ? 'neutral' : notFixed ? 'danger' : noResult || (s.check ?? 0) ? 'warn' : 'ok';
  const isLatest = !!shown && !!data?.current && shown.id === data.current.id;
  const canRemark = shown?.status === 'ready' && notFixed > 0;
  const canAsk = shown?.status === 'ready' && isLatest && noResult > 0 && !notFixed && !!data?.task.canAsk;
  const roleCtl = data?.task.canSetRoles && isLatest
    ? { manual, onChange: (sh: Shot, r: ManualRole) => void setRole(sh, r) }
    : null;
  const others = s.others ?? [];

  return (
    <div className="ba">
      <div className="ba-head">
        <div className="ba-head-text">
          <h3 className="ba-title">
            {functional ? <ListChecks size={18} aria-hidden /> : <GitCompareArrows size={18} aria-hidden />}
            {functional ? ' Чек-лист приёмки' : ' Было/стало'}
          </h3>
          <p className="ba-lead">
            {functional
              ? 'Пункты — критерии приёмки. Результат — отчёт исполнителя и его снимки; скринов «стало» не требуем.'
              : 'Слева — исходные материалы и замечания, справа — результат исполнителя. Образец от постановщика — отдельно.'}
          </p>
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
            {busy !== 'run' && !running && <RefreshCw size={15} aria-hidden />}
            {' '}{running ? 'Проверяю…' : data?.current ? 'Пересобрать отчёт' : 'Проверить было/стало'}
          </Button>
        </div>
      </div>

      {err && <div className="tv2-callout tv2-callout-danger" role="alert">{err}</div>}
      {data?.changed && isLatest && !running && (
        <div className="tv2-callout tv2-callout-info">
          После этой проверки в задаче появились новые материалы или поменялись роли снимков — нажмите «Пересобрать отчёт».
        </div>
      )}

      {!shown && !running && (
        <div className="ba-empty">
          <GitCompareArrows size={28} aria-hidden />
          <p className="ba-empty-title">Отчёта пока нет</p>
          <p className="ba-empty-hint">
            Система разложит задачу по пунктам и поставит рядом снимки «было» и «стало».
            {' '}Сейчас в задаче: снимков «было» — {data?.materials.before ?? 0}, «стало» — {data?.materials.after ?? 0}
            {data?.materials.examples ? `, образцов — ${data.materials.examples}` : ''}.
            {' '}После сдачи с результатом отчёт соберётся сам.
          </p>
        </div>
      )}

      {shown?.status === 'running' && (
        <div className="ba-running" role="status">
          <span className="ba-pulse" aria-hidden /> Сравниваю «было» и «стало» — это займёт до минуты. Можно закрыть карточку: отчёт сохранится.
        </div>
      )}
      {shown?.status === 'failed' && (
        <div className="tv2-callout tv2-callout-danger" role="alert">{shown.error ?? 'Проверка не удалась'} — нажмите «Пересобрать отчёт» ещё раз.</div>
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
            {s.askedResult && (
              <span className="ba-note">Попросили результат{s.askedResult.by ? ` — ${s.askedResult.by}` : ''}{s.askedResult.at ? `, ${when(s.askedResult.at)}` : ''}.</span>
            )}
            {isLatest && (data?.task.canDecide || canRemark || canAsk) && (
              <div className="ba-decide">
                {canAsk && !s.askedResult && (
                  <Button variant="outline" size="sm" onClick={() => void askResult()} loading={busy === 'ask'}>
                    {busy !== 'ask' && <Send size={15} aria-hidden />} Попросить результат
                  </Button>
                )}
                {data?.task.canDecide ? (
                  <>
                    <Button variant="primary" size="sm" onClick={() => void decide(true)} loading={busy === 'decide'}>Принять</Button>
                    <Button variant="outline" size="sm" onClick={() => void decide(false)} disabled={busy === 'decide'}>Вернуть на доработку</Button>
                  </>
                ) : canRemark ? (
                  <Button variant="outline" size="sm" onClick={() => void sendRemarks()}>Написать замечания исполнителю</Button>
                ) : null}
              </div>
            )}
          </div>

          {(s.examples?.length ?? 0) > 0 && (
            <section className="ba-item ba-examples" aria-label="Образец от постановщика">
              <div className="ba-item-head"><h4 className="ba-item-title">Образец от постановщика</h4></div>
              <p className="ba-detail ba-flush">Как должно быть — не исходный вид и не результат. Ошиблись с ролью — поменяйте её у снимка.</p>
              <div className="ba-gallery">
                {(s.examples ?? []).map((sh) => <ShotView key={sh.fileId} shot={sh} fallback="example" onOpen={open} role={roleCtl} />)}
              </div>
            </section>
          )}

          {functional && (s.afterReport?.length ?? 0) > 0 && (
            <section className="ba-item" aria-label="Отчёт исполнителя">
              <div className="ba-item-head"><h4 className="ba-item-title">Отчёт исполнителя</h4></div>
              <ul className="ba-report">
                {(s.afterReport ?? []).map((m, i) => (
                  <li key={`${m.at}-${i}`}><b>{m.author ?? '—'}</b>{m.at ? <span className="ba-cap"> · {when(m.at)}</span> : null}: {m.body}</li>
                ))}
              </ul>
            </section>
          )}

          <ol className="ba-items">
            {shown.items.map((it) => {
              const base = VERDICT[it.verdict] ?? VERDICT.eyes;
              const label = functional ? FUNCTIONAL_LABEL[it.verdict] ?? base.label : base.label;
              const mark = s.checked?.[String(it.n)];
              return (
                <li key={it.n} className="ba-item">
                  <div className="ba-item-head">
                    <span className="ba-num" aria-hidden>{it.n}</span>
                    <h4 className="ba-item-title"><span className="ba-sr">Пункт {it.n}. </span>{it.title}</h4>
                    <Badge tone={base.tone} className="ba-verdict"><base.Icon size={12} aria-hidden /> {label}</Badge>
                  </div>
                  {it.change && (it.change.from || it.change.to) && (
                    <p className="ba-change">
                      Было: «{it.change.from ?? '—'}» → Стало: {it.change.to ? `«${it.change.to}»` : 'убрано'}
                    </p>
                  )}
                  {it.detail && <p className="ba-detail">{it.detail}</p>}
                  {it.reason && <p className="ba-reason">{it.reason}</p>}
                  {functional && (
                    <div className="ba-check">
                      {data?.task.canCheck && isLatest ? (
                        <Checkbox
                          checked={!!mark}
                          onCheckedChange={(v) => void toggleChecked(it.n, v)}
                          label={mark ? `Проверено${mark.by ? ` — ${mark.by}` : ''}` : 'Проверено'}
                        />
                      ) : (
                        <span className="ba-note">{mark ? `Проверено${mark.by ? ` — ${mark.by}` : ''}` : 'Не проверено постановщиком'}</span>
                      )}
                    </div>
                  )}
                  {functional ? (
                    (it.before.length > 0 || it.after.length > 0) && (
                      <div className="ba-cols">
                        {it.before.length > 0 && <Column side="before" shots={it.before} onOpen={open} empty="" role={roleCtl} />}
                        {it.after.length > 0 && <Column side="after" label="Результат" shots={it.after} onOpen={open} empty="" role={roleCtl} />}
                      </div>
                    )
                  ) : (
                    <div className="ba-cols">
                      <Column side="before" shots={it.before} onOpen={open} role={roleCtl}
                        empty={it.change?.from ? `Скриншота «до» не было — показан прежний текст: «${it.change.from}»` : 'Скриншота «до» нет'} />
                      <Column side="after" shots={it.after} onOpen={open} empty="Результат не приложен" role={roleCtl} />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>

          {((s.loose?.before?.length ?? 0) + (s.loose?.after?.length ?? 0)) > 0 && (
            <section className="ba-item ba-loose">
              <div className="ba-item-head"><h4 className="ba-item-title">Снимки без привязки к пункту</h4></div>
              <div className="ba-cols">
                <Column side="before" shots={s.loose?.before ?? []} onOpen={open} empty="—" role={roleCtl} />
                <Column side="after" shots={s.loose?.after ?? []} onOpen={open} empty="—" role={roleCtl} />
              </div>
            </section>
          )}

          {others.length > 0 && (
            <details className="ba-item ba-others">
              <summary className="ba-item-title">Не относится к проверке и справка ({others.length})</summary>
              <div className="ba-gallery">
                {others.map((sh) => <ShotView key={sh.fileId} shot={sh} fallback="none" onOpen={open} role={roleCtl} />)}
              </div>
            </details>
          )}
        </>
      )}

      {light && <Lightbox items={light.items} index={light.index} onClose={() => setLight(null)} />}
    </div>
  );
}

type RoleCtl = { manual: Record<string, ManualRole>; onChange: (s: Shot, r: ManualRole) => void } | null;

function Column({ side, label, shots, empty, onOpen, role }: {
  side: 'before' | 'after'; label?: string; shots: Shot[]; empty: string; onOpen: (s: Shot) => void; role: RoleCtl;
}) {
  return (
    <div className="ba-col">
      <div className={`ba-label ba-label-${side}`}>{label ?? (side === 'before' ? 'Было' : 'Стало')}</div>
      {shots.length
        ? shots.map((s) => <ShotView key={s.fileId} shot={s} fallback={side} onOpen={onOpen} role={role} />)
        : <div className="ba-none">{empty}</div>}
    </div>
  );
}

/** Снимок с подписью и переключателем роли «Было / Образец / Стало / Не относится». */
function ShotView({ shot: s, fallback, onOpen, role }: { shot: Shot; fallback: ManualRole; onOpen: (s: Shot) => void; role: RoleCtl }) {
  const by = s.roleBy === 'manual' ? 'роль выбрана вручную' : s.roleBy === 'model' && s.role === 'example' ? 'образцом счёл ИИ' : null;
  return (
    <figure className="ba-shot">
      <div className="ba-shot-frame">
        <AuthedMedia fileId={s.fileId} name={s.name} mime={s.mime} className="ba-img" onOpen={() => onOpen(s)} />
      </div>
      <figcaption className="ba-cap">
        {[s.origin === 'page' ? 'Снимок страницы' : s.by, s.at ? when(s.at) : null, by].filter(Boolean).join(' · ')}
        {s.caption && s.origin !== 'page' && <span className="ba-cap-text"> — {s.caption}</span>}
        {s.url && <> — <a href={s.url} target="_blank" rel="noreferrer noopener">{s.url}</a></>}
      </figcaption>
      {role && s.origin !== 'page' && (
        <Select
          size="sm"
          className="ba-role"
          ariaLabel={`Роль снимка ${s.name}`}
          value={shownRole(s, fallback, role.manual)}
          onValueChange={(v) => role.onChange(s, v as ManualRole)}
          options={ROLE_OPTIONS}
        />
      )}
    </figure>
  );
}
