import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { ClientsRepository } from '../clients/clients.repository';
import { PushService } from '../notifications/push.service';
import { fingerprint } from '../proactive/proactive-rules';
import { ProposalRow } from '../proactive/proactive.repository';
import { Actor, ProactiveService } from '../proactive/proactive.service';
import { ProactiveScheduler } from '../proactive/proactive.scheduler';
import { RealtimeService } from '../realtime/realtime.service';
import { MeetingsRepository } from './meetings.repository';
import { newsKind } from './postcall-rules';
import { BlockStatus, PostcallBlock, PostcallRepository, PostcallRow } from './postcall.repository';

/** «Разобрать позже» не прячет итоги — лишь откладывает напоминание о них. */
const SNOOZE_HOURS = 3;

/**
 * Разбор встречи после звонка (ТЗ-22).
 *
 * Звонок закончен не тогда, когда отключился звук, а когда договорённости стали
 * действиями. Разбор — это и есть «стали ли»: увидел ли человек итоги, что создал,
 * закрыл ли. Конвейер встречи отмечает здесь готовность блоков, экран итогов
 * перерисовывается по событию `meeting.postcall`.
 */
@Injectable()
export class PostcallService implements OnModuleInit {
  private readonly log = new Logger(PostcallService.name);

  constructor(
    private readonly repo: PostcallRepository,
    private readonly meetings: MeetingsRepository,
    private readonly realtime: RealtimeService,
    private readonly push: PushService,
    private readonly proactive: ProactiveService,
    private readonly scheduler: ProactiveScheduler,
    private readonly clients: ClientsRepository,
  ) {}

  onModuleInit(): void {
    this.proactive.register({ skill: 'postcall', execute: (a, p, action) => this.executeCard(a, p, action) });
    this.scheduler.add('итоги встреч: не разобраны', async () => { await this.remindStale(); });
  }

  /**
   * «Требуют внимания» (§30, §49): итоги, которые не разобрали за сутки или отложили
   * «на потом», возвращаются карточкой в ящик секретаря. Один раз на разбор.
   */
  async remindStale(): Promise<number> {
    const rows = await this.repo.stale();
    for (const r of rows) {
      if (!(await this.repo.claimRemind(r.id))) continue;
      const left = r.pending_drafts;
      await this.proactive.propose({
        tenantId: r.tenant_id, userId: r.owner_id, skill: 'postcall', kind: 'review',
        sourceType: 'meeting', sourceId: r.meeting_id, sourceAt: r.created_at,
        sourceLabel: `Встреча «${r.title}»`, sourceLink: `/meetings/${r.meeting_id}/postcall`,
        title: `Итоги встречи не разобраны: ${r.title}`.slice(0, 200),
        summary: left ? `Черновиков задач ждут решения: ${left}.` : 'Итоги готовы, разбор не закрыт.',
        why: 'Договорённости встречи становятся работой, только когда по ним созданы задачи.',
        recommend: left ? 'открыть итоги и создать задачи' : 'открыть итоги и закрыть разбор',
        effect: 'Откроется экран итогов встречи; ничего не создаётся без вас.',
        priority: left ? 1 : 3, confidence: 0.95,
        actions: [{ key: 'done', label: 'Уже разобрал', risk: 'low_write' }],
        payload: { meetingId: r.meeting_id },
        fingerprint: fingerprint({ skill: 'postcall', sourceType: 'meeting', sourceId: r.meeting_id }),
        expiresAt: new Date(Date.now() + 7 * 86400_000),
      });
    }
    return rows.length;
  }

  /** «Уже разобрал» из ящика — закрывает разбор, как кнопка на экране итогов. */
  private async executeCard(a: Actor, p: ProposalRow, action: string) {
    if (action !== 'done') throw AppException.validation('Неизвестное действие');
    const meetingId = String((p.payload as { meetingId?: string }).meetingId ?? p.source_id);
    await this.complete(a.tenantId, meetingId, a.userId, false);
    return { text: 'Разбор встречи закрыт', link: `/meetings/${meetingId}` };
  }

  /**
   * Завести разбор, как только появилась встреча. Владелец — организатор события,
   * из которого начали созвон, иначе тот, кто созвон начал.
   */
  async start(i: {
    tenantId: string; meetingId: string; startedBy: string | null; ai: boolean;
    attendees: { userId: string; name: string }[];
  }): Promise<PostcallRow | null> {
    try {
      const organizer = await this.repo.eventOrganizer(i.meetingId).catch(() => null);
      const row = await this.repo.create({
        tenantId: i.tenantId, meetingId: i.meetingId, ownerId: organizer?.id ?? i.startedBy, ai: i.ai,
        participants: i.attendees.map((a) => ({
          userId: a.userId.startsWith('guest:') ? '' : a.userId,
          name: a.userId.startsWith('guest:') ? `${a.name} (гость)` : a.name,
          guest: a.userId.startsWith('guest:'),
        })),
      });
      await this.emit(i.tenantId, row);
      return row;
    } catch (e) {
      // без разбора встреча всё равно разберётся — экран лишь не покажет прогресс
      this.log.warn(`разбор встречи ${i.meetingId} не заведён: ${(e as Error).message}`);
      return null;
    }
  }

  /** Отметка конвейера: блок начат / готов / упал. Встречи без разбора (загруженные файлы) — молча мимо. */
  async mark(tenantId: string, meetingId: string, patch: Partial<Record<PostcallBlock, BlockStatus>>): Promise<void> {
    try {
      const row = await this.repo.setBlocks(meetingId, patch);
      if (row) await this.emit(tenantId, row);
      if (row?.status === 'review_required' && (await this.repo.claimNotify(row.id))) await this.notifyReady(tenantId, row);
    } catch (e) {
      this.log.warn(`разбор встречи ${meetingId}: ${(e as Error).message}`);
    }
  }

  /** Всё, что ещё не готово, — упало: конвейер оборвался, экран не должен крутиться вечно. */
  async failRest(tenantId: string, meetingId: string): Promise<void> {
    const row = await this.repo.byMeeting(tenantId, meetingId);
    if (!row) return;
    const patch: Partial<Record<PostcallBlock, BlockStatus>> = {};
    for (const b of ['transcript', 'summary', 'decisions', 'tasks', 'followup'] as PostcallBlock[]) {
      const s = row[`${b}_status` as const];
      if (s === 'pending' || s === 'running') patch[b] = b === 'followup' ? 'skipped' : 'failed';
    }
    await this.mark(tenantId, meetingId, patch);
  }

  /** Письмо клиенту не понадобилось — блок не держит разбор в «обрабатывается». */
  async settleFollowup(tenantId: string, meetingId: string): Promise<void> {
    await this.repo.settleFollowup(meetingId);
    await this.mark(tenantId, meetingId, {});
  }

  followupFor(tenantId: string, userId: string, meetingId: string) {
    return this.repo.followupFor(tenantId, userId, meetingId);
  }

  /**
   * «Итоги встречи готовы» (§48). Владельцу — уведомлением с push, если экран итогов он
   * так и не открыл (ушёл раньше, чем они собрались). Остальным сотрудникам со встречи —
   * тихо, в колокольчик: те, кто ушёл раньше, узнают, что итоги появились.
   */
  private async notifyReady(tenantId: string, row: PostcallRow): Promise<void> {
    const counts = await this.repo.counts(row.meeting_id).catch(() => null);
    const parts = counts ? [
      counts.drafts ? `${counts.drafts} ${plural(counts.drafts, 'задача', 'задачи', 'задач')}` : '',
      counts.decisions ? `${counts.decisions} ${plural(counts.decisions, 'решение', 'решения', 'решений')}` : '',
      row.followup_status === 'ready' ? 'письмо клиенту' : '',
    ].filter(Boolean) : [];
    const title = `Итоги встречи готовы${counts?.title ? `: ${counts.title}` : ''}`.slice(0, 120);
    const body = row.ai ? (parts.join(' · ') || 'Краткие итоги и стенограмма') : 'Запись сохранена';
    const path = `/meetings/${row.meeting_id}/postcall`;
    if (row.owner_id && !row.opened_at) {
      await this.push.personal({ tenantId, userId: String(row.owner_id), eventKey: 'meeting.postcall', title, body: `${body} — разберите`, path }).catch(() => false);
    }
    for (const p of row.participants ?? []) {
      if (!p.userId || String(p.userId) === String(row.owner_id)) continue;
      await this.push.personal({ tenantId, userId: String(p.userId), eventKey: 'meeting.postcall', title, body, path, push: false }).catch(() => false);
    }
  }

  /**
   * «Отправить итоги участникам» (§21): краткое, решения и сколько задач — каждому
   * сотруднику со встречи. Один раз: второе нажатие людей не дёргает.
   */
  async recap(tenantId: string, meetingId: string, userId: string) {
    const row = await this.own(tenantId, meetingId, userId);
    const people = (row.participants ?? []).filter((p) => p.userId && String(p.userId) !== String(userId));
    if (!people.length) throw AppException.validation('Кроме вас, на встрече не было сотрудников');
    if (!(await this.repo.claimRecap(row.id))) throw AppException.conflict('Итоги участникам уже отправлены');
    const counts = await this.repo.counts(meetingId).catch(() => null);
    const summary = (counts?.summary ?? '').slice(0, 180);
    const tail = counts ? [
      counts.decisions ? `решений: ${counts.decisions}` : '',
      counts.tasks ? `задач: ${counts.tasks}` : '',
    ].filter(Boolean).join(', ') : '';
    for (const p of people) {
      await this.push.personal({
        tenantId, userId: String(p.userId), eventKey: 'meeting.recap',
        title: `Итоги встречи${counts?.title ? `: ${counts.title}` : ''}`.slice(0, 120),
        body: [summary, tail].filter(Boolean).join(' · ') || 'Итоги готовы',
        path: `/meetings/${meetingId}/postcall`,
      }).catch(() => false);
    }
    return { sent: people.length };
  }

  /** «Подготовить пост в Новости» — только у встречи с вехой (§26). */
  async toNews(tenantId: string, meetingId: string, userId: string, meeting: { title: string; project_id: string | null }, decisions: string[]) {
    await this.own(tenantId, meetingId, userId);
    const type = newsKind(decisions);
    if (!type) throw AppException.validation('В решениях встречи нет вехи — обычные итоги в «Новости» не идут');
    const picked = decisions.filter((d) => newsKind([d])).slice(0, 3);
    const id = await this.repo.addNewsCandidate({
      tenantId, meetingId, projectId: meeting.project_id, type, decisions: picked,
      title: picked[0] ?? meeting.title, body: picked.join('\n'),
    });
    return { candidateId: id, already: !id };
  }

  /** Перезапуск конвейера: блоки снова ждут, разбор снова «обрабатывается». */
  async restart(tenantId: string, meetingId: string): Promise<void> {
    const row = await this.repo.byMeeting(tenantId, meetingId);
    if (!row || row.status === 'completed') return;
    await this.repo.reset(row.id);
    await this.mark(tenantId, meetingId, {});
  }

  review(tenantId: string, meetingId: string) {
    return this.repo.byMeeting(tenantId, meetingId);
  }

  async opened(row: PostcallRow): Promise<void> {
    if (!row.opened_at) await this.repo.markOpened(row.id);
  }

  meetingByRoom(tenantId: string, roomId: string) {
    return this.repo.meetingByRoom(tenantId, roomId);
  }

  pending(tenantId: string, userId: string) {
    return this.repo.pendingFor(tenantId, userId);
  }

  /** Закрывает разбор владелец; у разбора без владельца — любой сотрудник, кто видит встречу. */
  canClose(row: PostcallRow, userId: string): boolean {
    return !row.owner_id || String(row.owner_id) === String(userId);
  }

  async snooze(tenantId: string, meetingId: string, userId: string) {
    const row = await this.own(tenantId, meetingId, userId);
    const until = new Date(Date.now() + SNOOZE_HOURS * 3600_000);
    await this.repo.snooze(row.id, until);
    return { snoozedUntil: until };
  }

  /**
   * «Завершить разбор». Не заставляем делать всё: часть черновиков может остаться,
   * письмо — не уйти. Разбор всё равно закрыт, решение человека сохранено.
   */
  async complete(tenantId: string, meetingId: string, userId: string, followupSent: boolean) {
    const row = await this.own(tenantId, meetingId, userId);
    const status = row.followup_status === 'ready' && !followupSent ? 'reviewed' : 'completed';
    const done = await this.repo.finish(row.id, status);
    if (done) await this.emit(tenantId, done);
    // карточка «итоги не разобраны» больше не нужна — закрываем её сами
    await this.proactive.resolveBySource(tenantId, 'postcall', 'meeting', String(meetingId), 'Разбор закрыт').catch(() => undefined);
    // встреча с клиентом — итог в его ленту (§25): что решили и сколько задач поставили
    const c = await this.repo.counts(meetingId).catch(() => null);
    if (c?.client_id) {
      const what = [c.decisions ? `решений: ${c.decisions}` : '', c.tasks ? `задач: ${c.tasks}` : ''].filter(Boolean).join(', ');
      await this.clients.log(tenantId, c.client_id, userId, 'meeting', `Итоги встречи «${c.title}» разобраны${what ? ` — ${what}` : ''}`,
        { type: 'meeting', id: String(meetingId) });
    }
    return { status };
  }

  private async own(tenantId: string, meetingId: string, userId: string): Promise<PostcallRow> {
    const row = await this.repo.byMeeting(tenantId, meetingId);
    if (!row) throw AppException.notFound('Итогов у этой встречи нет');
    if (!this.canClose(row, userId)) throw AppException.forbidden('Разбор закрывает организатор встречи');
    return row;
  }

  /** Событие всем, кто ждёт итогов: участникам встречи и владельцу разбора. */
  private async emit(tenantId: string, row: PostcallRow): Promise<void> {
    const people = await this.meetings.audience(tenantId, row.meeting_id).catch(() => []);
    const ids = new Set(people.map((p) => String(p.user_id)));
    if (row.owner_id) ids.add(String(row.owner_id));
    for (const p of row.participants ?? []) if (p.userId) ids.add(String(p.userId));
    this.realtime.emitToUsers(tenantId, [...ids], 'meeting.postcall', {
      meetingId: String(row.meeting_id), status: row.status, blocks: blocksOf(row),
    });
  }
}

const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10; const h = n % 100;
  if (d === 1 && h !== 11) return one;
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few;
  return many;
};

export function blocksOf(row: PostcallRow): Record<PostcallBlock, BlockStatus> {
  return {
    transcript: row.transcript_status, summary: row.summary_status, decisions: row.decisions_status,
    tasks: row.tasks_status, followup: row.followup_status,
  };
}
