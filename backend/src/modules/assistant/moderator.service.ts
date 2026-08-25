import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SecretaryService } from '../secretary/secretary.service';
import {
  AgendaSource, agendaPrompt, agendaSummary, collectFacts, factsToText, usableAgenda,
} from './agenda-rules';
import { DueEvent, ModeratorRepository } from './moderator.repository';

/**
 * Как модель должна писать повестку.
 *
 * Запрет выдумывать стоит первым пунктом не для красоты: повестка — это то, что люди
 * прочитают за минуту до встречи и примут за правду. Придуманный пункт здесь дороже,
 * чем придуманная строка в любом другом месте продукта.
 */
const AGENDA_SYSTEM = [
  'Ты секретарь встречи. По фактам ниже составь короткую повестку на русском языке.',
  'Строгие правила:',
  '— используй ТОЛЬКО данные факты, ничего не добавляй и не додумывай;',
  '— 3–6 пунктов, каждый с новой строки, начинай пункт с «— »;',
  '— пункт это вопрос или тема к обсуждению, а не пересказ факта;',
  '— без вступлений, приветствий и выводов — только пункты;',
  '— имена людей сохраняй как есть.',
].join('\n');

@Injectable()
export class ModeratorService {
  private readonly log = new Logger('Moderator');

  constructor(
    private readonly repo: ModeratorRepository,
    private readonly ai: AiService,
    private readonly realtime: RealtimeService,
    private readonly secretary: SecretaryService,
  ) {}

  // ---------- чтение ----------

  async agenda(tenantId: string, eventId: string) {
    const row = await this.repo.agenda(tenantId, eventId);
    if (!row) throw AppException.notFound('Повестка не найдена');
    return {
      eventId: row.event_id,
      title: row.title,
      startsAt: row.starts_at,
      body: row.body,
      facts: row.facts,
      meetRoomId: row.meet_room_id,
    };
  }

  upcoming(tenantId: string, userId: string) {
    return this.repo.upcomingFor(tenantId, userId).then((rows) => rows.map((r) => ({
      eventId: r.event_id,
      title: r.title,
      startsAt: r.starts_at,
      body: r.body,
      meetRoomId: r.meet_room_id,
    })));
  }

  // ---------- проход планировщика ----------

  /** Одна встреча: собрать факты, дать модели сформулировать, разослать участникам. */
  async prepare(event: DueEvent): Promise<boolean> {
    const people = await this.repo.participants(event.id);
    if (people.length < 2) return false; // повестка самому себе — это заметка
    const userIds = people.map((p) => String(p.user_id));

    const [previousDecisions, awaitingReview, overdue, approvals] = await Promise.all([
      this.repo.previousDecisions(event.tenant_id, event.id),
      this.repo.awaitingReview(event.tenant_id, userIds),
      this.repo.overdue(event.tenant_id, userIds),
      this.repo.approvals(event.tenant_id, userIds),
    ]);

    const source: AgendaSource = {
      title: event.title,
      description: event.description,
      participants: people.map((p) => p.full_name),
      previousDecisions,
      awaitingReview,
      overdue: overdue.map((t) => ({ ...t, days: Number(t.days) })),
      approvals,
    };
    const facts = collectFacts(source);
    // Обсуждать нечего и напоминать не о чем — молчим. Повестка «пунктов нет»
    // ничего не даёт, зато приучает не читать уведомления от ассистента.
    if (!facts.length) return false;

    const body = await this.formulate(event.tenant_id, source, facts);
    await this.repo.saveAgenda({
      tenantId: event.tenant_id, eventId: event.id, startsAt: event.starts_at, body, facts,
    });

    this.realtime.emitToUsers(event.tenant_id, userIds, 'assistant.agenda', {
      eventId: String(event.id),
      title: event.title,
      startsAt: event.starts_at,
      body,
      meetRoomId: event.meet_room_id,
    });
    void this.secretary.record({
      tenantId: event.tenant_id, userId: String(event.owner_id), kind: 'agenda',
      summary: agendaSummary(event.title, facts.length),
    });
    return true;
  }

  /**
   * Формулировка. Модель тут не обязательна: факты уже готовы к чтению.
   *
   * Поэтому любая её осечка — нет ключа, кончились деньги, ответ не похож на повестку —
   * заканчивается фактами, а не молчанием: встреча через пять минут не станет ждать,
   * пока починят ИИ.
   */
  private async formulate(tenantId: string, source: AgendaSource, facts: ReturnType<typeof collectFacts>): Promise<string> {
    const fallback = factsToText(facts);
    try {
      const answer = await this.ai.generate(tenantId, AGENDA_SYSTEM, agendaPrompt(source, facts), 'meeting_agenda');
      return usableAgenda(answer, facts.length) ? answer.trim() : fallback;
    } catch (e) {
      this.log.warn(`повестка «${source.title}»: модель не ответила — ${(e as Error).message}`);
      return fallback;
    }
  }
}
