import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { SecretaryService } from '../secretary/secretary.service';
import { AssistantMode, AssistantRepository, PingRow } from './assistant.repository';
import { dedupKey, PingCandidate, pingText, withinWorkHours } from './ping-rules';

/** Через сколько часов на проверке работа считается зависшей — как в «Пульсе команды». */
const STUCK_HOURS = 24;
/** Сколько дней задача без срока может стоять молча, прежде чем о ней спросят. */
const SILENT_DAYS = 5;
/** Больше — это уже не помощь: столько напоминаний за один проход на человека. */
const MAX_PER_USER = 3;

const MODES: AssistantMode[] = ['off', 'copilot', 'autopilot'];

@Injectable()
export class AssistantService {
  private readonly log = new Logger('Assistant');

  constructor(
    private readonly repo: AssistantRepository,
    private readonly realtime: RealtimeService,
    private readonly secretary: SecretaryService,
  ) {}

  // ---------- режим ----------

  async mode(tenantId: string) {
    const [mode, autoTasks] = await Promise.all([this.repo.mode(tenantId), this.repo.autoTasks(tenantId)]);
    return { mode, autoTasks };
  }

  /**
   * Создавать ли задачи со встречи сразу.
   *
   * Отдельно от режима: разбор встречи может создавать задачи и в копилоте — там
   * решение уже принято людьми вслух, а вот дёргать человека напоминанием без
   * подтверждения это другое дело.
   */
  async setAutoTasks(tenantId: string, role: string, enabled: boolean) {
    if (role !== 'owner') throw AppException.forbidden('Настройку задаёт владелец');
    return { autoTasks: await this.repo.setAutoTasks(tenantId, enabled) };
  }

  async setMode(tenantId: string, role: string, mode: string) {
    if (role !== 'owner') throw AppException.forbidden('Режим ассистента задаёт владелец');
    if (!MODES.includes(mode as AssistantMode)) throw AppException.validation('Неизвестный режим');
    await this.repo.setMode(tenantId, mode as AssistantMode);
    return this.mode(tenantId);
  }

  // ---------- чтение ----------

  listForUser(tenantId: string, userId: string) {
    return this.repo.listForUser(tenantId, userId).then((rows) => rows.map(view));
  }

  listProposed(tenantId: string, userId: string) {
    return this.repo.listProposed(tenantId, userId).then((rows) => rows.map(view));
  }

  // ---------- действия человека ----------

  /**
   * Отправить предложенное напоминание.
   *
   * Право решать — у постановщика задачи: это его вопрос «как дела с задачей».
   * Получателю пинга своё же напоминание отправлять незачем — оно уже про него.
   */
  async send(tenantId: string, userId: string, id: string) {
    const ping = await this.gate(tenantId, userId, id);
    if (ping.status !== 'proposed') throw AppException.conflict('Это напоминание уже отправлено');
    await this.repo.setStatus(tenantId, id, 'sent');
    this.deliver(tenantId, String(ping.user_id), id, ping.text, ping.task_id);
    void this.secretary.record({
      tenantId, userId: String(ping.user_id), kind: 'ping',
      summary: ping.text, subjectType: 'task', subjectId: ping.task_id,
    });
    return { sent: true };
  }

  /** Скрыть: и получателю (прочитал), и постановщику (не надо дёргать). */
  async dismiss(tenantId: string, userId: string, id: string) {
    await this.gate(tenantId, userId, id);
    await this.repo.setStatus(tenantId, id, 'dismissed');
    return { dismissed: true };
  }

  private async gate(tenantId: string, userId: string, id: string) {
    const ping = await this.repo.byId(tenantId, id);
    if (!ping) throw AppException.notFound('Напоминание не найдено');
    const mine = String(ping.user_id) === String(userId);
    const isManager = ping.created_by !== null && String(ping.created_by) === String(userId);
    if (!mine && !isManager) throw AppException.forbidden('Это напоминание адресовано другому человеку');
    return ping;
  }

  // ---------- проход планировщика ----------

  /**
   * Один проход по организации: найти поводы и разложить их по людям.
   *
   * Тихие часы проверяются по поясу ПОЛУЧАТЕЛЯ, а не сервера. В режиме «копилот»
   * ничего не рассылается — ассистент только предлагает, и предложение ждёт человека
   * столько, сколько нужно: у предложения тихих часов нет, у отправки есть.
   */
  async runTenant(tenantId: string, mode: AssistantMode, now = new Date()): Promise<number> {
    if (mode === 'off') return 0;
    const [work, candidates] = await Promise.all([
      this.repo.workHours(tenantId),
      this.repo.candidates(tenantId, STUCK_HOURS, SILENT_DAYS),
    ]);

    const perUser = new Map<string, number>();
    let created = 0;

    for (const c of candidates) {
      if (!c.userId || !c.taskId) continue;
      const sent = mode === 'autopilot';
      // молчим только когда СОБИРАЕМСЯ ПИСАТЬ: предложение полежит до утра само
      if (sent && !withinWorkHours(now, c.timezone, work)) continue;
      const already = perUser.get(c.userId) ?? 0;
      if (already >= MAX_PER_USER) continue;

      const text = pingText(c as PingCandidate);
      const row = await this.repo.create({
        tenantId, userId: c.userId, kind: c.kind, taskId: c.taskId, text,
        status: sent ? 'sent' : 'proposed',
        dedupKey: dedupKey(c as PingCandidate, now),
      });
      if (!row) continue; // сегодня об этом уже напоминали

      perUser.set(c.userId, already + 1);
      created++;
      if (sent) {
        this.deliver(tenantId, c.userId, row.id, text, c.taskId);
        void this.secretary.record({
          tenantId, userId: c.userId, kind: 'ping',
          summary: text, subjectType: 'task', subjectId: c.taskId,
        });
      }
    }
    return created;
  }

  /** Доставка в открытое приложение. Почтой не шлём: напоминание — не письмо. */
  private deliver(tenantId: string, userId: string, pingId: string, text: string, taskId: string | null): void {
    this.realtime.emitToUsers(tenantId, [String(userId)], 'assistant.ping', {
      id: String(pingId), text, taskId: taskId ? String(taskId) : null,
    });
  }
}

function view(r: PingRow) {
  return {
    id: r.id,
    kind: r.kind,
    taskId: r.task_id,
    projectId: r.project_id,
    text: r.text,
    status: r.status,
    createdAt: r.created_at,
    /** Кому адресовано — нужно постановщику в списке предложений. */
    toName: r.user_name,
    assigneeName: r.assignee_name,
  };
}
