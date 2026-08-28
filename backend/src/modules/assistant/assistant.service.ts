import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { SecretaryService } from '../secretary/secretary.service';
import { AssistantMode, AssistantRepository, PingRow } from './assistant.repository';
import {
  digestKey, digestText, greetingFor, INSTANT_KINDS, KindStats, mutedKinds, PingCandidate,
  PingKind, pingKey, pingText, reactionRate, repeatDue, withinWorkHours,
} from './ping-rules';
import { TelegramMirror } from '../notifications/telegram-mirror.service';

/** Через сколько часов на проверке работа считается зависшей — как в «Пульсе команды». */
const STUCK_HOURS = 24;
/** Сколько дней задача без срока может стоять молча, прежде чем о ней спросят. */
const SILENT_DAYS = 5;

const MODES: AssistantMode[] = ['off', 'copilot', 'autopilot'];

@Injectable()
export class AssistantService {
  private readonly log = new Logger('Assistant');

  constructor(
    private readonly repo: AssistantRepository,
    private readonly realtime: RealtimeService,
    private readonly secretary: SecretaryService,
    private readonly telegram: TelegramMirror,
  ) {}

  // ---------- режим ----------

  async mode(tenantId: string) {
    const [mode, autoTasks, maintenance] = await Promise.all([
      this.repo.mode(tenantId), this.repo.autoTasks(tenantId), this.repo.maintenance(tenantId),
    ]);
    return { mode, autoTasks, maintenance };
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
    this.announce(tenantId, String(ping.user_id), id, ping.text, ping.task_id);
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
   * Один проход по организации.
   *
   * Устройство прохода — прямое следствие живой проверки: 190 напоминаний за четыре
   * дня и реакция в 14 нажатий «скрыть». Поэтому теперь так:
   *
   * — накопительные поводы (просрочка, зависшая проверка, молчащая задача) НЕ летят
   *   поодиночке. Они собираются в одну утреннюю сводку — по рабочему календарю и
   *   поясу получателя, один раз в день;
   * — мгновенно уходит только «срок сегодня»: сказать об этом в обед бессмысленно;
   * — повод, о котором уже говорили, повторяется по нарастающей паузе, а не каждое
   *   утро. Человек, третью неделю не двигающий задачу, принял решение, а не забыл.
   *
   * В режиме «копилот» рассылки нет вовсе: поводы копятся предложениями и ждут
   * решения постановщика — там шум создать невозможно.
   */
  async runTenant(tenantId: string, mode: AssistantMode, now = new Date()): Promise<number> {
    if (mode === 'off') return 0;
    const [work, candidates, stats] = await Promise.all([
      this.repo.workHours(tenantId),
      this.repo.candidates(tenantId, STUCK_HOURS, SILENT_DAYS),
      this.stats(tenantId),
    ]);
    const autopilot = mode === 'autopilot';
    // Поводы, на которые в этой компании перестали отвечать: они не исчезают,
    // но напоминают не чаще раза в неделю.
    const muted = new Set(mutedKinds(stats));

    const byUser = new Map<string, PingCandidate[]>();
    for (const c of candidates) {
      if (!c.userId || !c.subjectId) continue;
      const list = byUser.get(c.userId) ?? [];
      list.push(c as PingCandidate);
      byUser.set(c.userId, list);
    }

    let created = 0;
    for (const [userId, items] of byUser) {
      const tz = items[0].timezone;
      // Сводку собираем в первый проход внутри рабочего дня человека — и только если
      // сегодня её ещё не было. Не «ровно в девять»: кто-то начинает позже, кто-то
      // включает ноутбук после обеда, а сервер вообще мог в это время перезапускаться.
      const digestDue = withinWorkHours(now, tz, work)
        && !(await this.repo.byKey(tenantId, digestKey(userId, now, tz)));
      const forDigest: PingCandidate[] = [];

      for (const c of items) {
        const instant = INSTANT_KINDS.includes(c.kind);
        // Накопительные поводы трогаем только утром: иначе счётчик повторов
        // прокрутится за день четырежды, и затухание перестанет работать.
        if (!instant && !digestDue) continue;

        const fresh = await this.touch(tenantId, c, autopilot, now, muted.has(c.kind));
        if (!fresh) continue; // повод спит до следующего повтора
        created++;

        if (!autopilot) continue; // копилот: ждём решения постановщика
        if (instant && withinWorkHours(now, tz, work)) this.announce(tenantId, userId, fresh.id, fresh.text, c.taskId);
        if (!instant) forDigest.push(c);
      }

      if (autopilot && digestDue && forDigest.length) {
        created += await this.sendDigest(tenantId, userId, tz, forDigest, now) ? 1 : 0;
      }
    }
    return created;
  }

  /**
   * Завести повод или повторить его, если пришло время.
   *
   * Возвращает null, когда повод уже известен и повторять рано, — это и есть тишина,
   * ради которой всё затевалось.
   */
  private async touch(
    tenantId: string, c: PingCandidate, autopilot: boolean, now: Date, muted = false,
  ): Promise<{ id: string; text: string } | null> {
    const key = pingKey(c);
    const text = pingText(c);
    const status = autopilot ? 'sent' : 'proposed';

    const existing = await this.repo.byKey(tenantId, key);
    if (!existing) {
      const row = await this.repo.create({
        tenantId, userId: c.userId, kind: c.kind, taskId: c.taskId, text, status, dedupKey: key,
      });
      return row ? { id: row.id, text } : null;
    }
    // «Не надо» сказано однажды и навсегда: скрытый повод сам не воскресает.
    if (existing.status === 'dismissed') return null;
    // Предложение уже лежит у постановщика — до его решения повторять нечего.
    if (existing.status === 'proposed') return null;
    if (!repeatDue(existing.repeats, existing.last_sent_at, now, muted)) return null;
    await this.repo.repeat(tenantId, existing.id, text, status);
    return { id: existing.id, text };
  }

  /** Сводка: одна на человека в день, в приложение и в Telegram. */
  private async sendDigest(
    tenantId: string, userId: string, tz: string | null, items: PingCandidate[], now: Date,
  ): Promise<boolean> {
    const key = digestKey(userId, now, tz);
    const text = digestText(items, greetingFor(now, tz));
    if (!text) return false;
    const row = await this.repo.create({
      tenantId, userId, kind: 'digest', taskId: null, text, status: 'sent', dedupKey: key,
    });
    if (!row) return false; // сводку сегодня уже присылали

    this.announce(tenantId, userId, row.id, text, null);
    void this.telegram.push(tenantId, userId, text);
    void this.secretary.record({
      tenantId, userId, kind: 'digest', summary: `Сводка дня: ${items.length} дел`,
    });
    return true;
  }

  /** Статистика отклика за две недели: столько нужно, чтобы вывод не был случайным. */
  private async stats(tenantId: string): Promise<KindStats[]> {
    const rows = await this.repo.reactionStats(tenantId, 14).catch(() => []);
    return rows.map((r) => ({ kind: r.kind as PingKind, sent: Number(r.sent), acted: Number(r.acted) }));
  }

  /**
   * Отклик для панели секретаря: сколько напоминаний привели к делу.
   *
   * Показывать «сделано 190 действий» вместо этого — самообман: непрочитанное
   * напоминание не экономит ни минуты.
   */
  async reaction(tenantId: string) {
    const stats = await this.stats(tenantId);
    return {
      rate: reactionRate(stats),
      sent: stats.reduce((n, s) => n + s.sent, 0),
      muted: mutedKinds(stats),
      byKind: stats,
    };
  }

  /** Ответ делом: «Сделаю сегодня». Отличается от «Скрыть» — по нему и считается отклик. */
  async acted(tenantId: string, userId: string, id: string) {
    const ping = await this.gate(tenantId, userId, id);
    await this.repo.setStatus(tenantId, String(ping.id), 'done');
    return { done: true };
  }

  /** Доставка в открытое приложение. Почтой не шлём: напоминание — не письмо. */
  private announce(tenantId: string, userId: string, pingId: string, text: string, taskId: string | null): void {
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
