import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { guardProtocol } from '../../common/personal-topics';
import { runsBackground } from '../../common/process-role';
import { maskSecrets } from '../../common/secrets';
import { DbService } from '../../database/db.service';

/** Версия правил: подняли — уборка пройдёт протоколы ещё раз. */
export const PROTOCOL_PRIVACY_V = 1;

/**
 * #4925, п. 2: уже созданные протоколы — через тот же фильтр, что новые (guardProtocol):
 * пароли маской, личное — вон из сводки, решений и вопросов, в рисках — нейтрально
 * «риск доступности исполнителя». Заодно черновики задач встречи и журнал решений: туда
 * решения копируются, и пароль остался бы там.
 *
 * Стенограмму не трогаем: это запись разговора, её слышно в аудио.
 */
@Injectable()
export class ProtocolPrivacyService implements OnModuleInit {
  private readonly log = new Logger('ProtocolPrivacy');
  constructor(private readonly db: DbService) {}

  onModuleInit(): void {
    if (!runsBackground() || process.env.NODE_ENV === 'test') return;
    // после старта — не мешаем выкладке; сине-зелёный второй цвет просто не найдёт работы
    const t = setTimeout(() => { void this.run().catch((e) => this.log.warn(`уборка протоколов: ${(e as Error).message}`)); }, 90_000);
    t.unref?.();
  }

  async run(batch = 50): Promise<number> {
    let done = 0;
    for (;;) {
      const rows = await this.db.many<{ meeting_id: string; tenant_id: string; summary: string | null; decisions: unknown; risks: unknown; questions: unknown }>(
        `SELECT meeting_id::text, tenant_id::text, summary, decisions, risks, questions
           FROM meeting_summaries WHERE privacy_v < $1 ORDER BY meeting_id LIMIT $2`,
        [PROTOCOL_PRIVACY_V, batch]);
      if (!rows.length) break;
      for (const r of rows) {
        await this.one(r).catch((e) => this.log.warn(`протокол ${r.meeting_id}: ${(e as Error).message}`));
        // не прошёл — всё равно отмечаем: иначе одна битая строка крутила бы цикл вечно
        await this.db.query(`UPDATE meeting_summaries SET privacy_v = $2 WHERE meeting_id = $1`, [r.meeting_id, PROTOCOL_PRIVACY_V]);
        done++;
      }
    }
    if (done) this.log.log(`протоколы проверены на пароли и личное: ${done}`);
    return done;
  }

  private async one(r: { meeting_id: string; tenant_id: string; summary: string | null; decisions: unknown; risks: unknown; questions: unknown }) {
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : String((x as { text?: string })?.text ?? ''))).filter(Boolean) : []);
    const drafts = await this.db.many<{ id: string; title: string; description: string | null; quote: string | null }>(
      `SELECT id::text, title, description, quote FROM meeting_task_drafts WHERE meeting_id = $1`, [r.meeting_id]);
    const value = guardProtocol({
      summary: r.summary ?? '',
      decisions: strings(r.decisions).map((text) => ({ text })),
      risks: strings(r.risks),
      questions: strings(r.questions).map((text) => ({ text })),
      tasks: drafts.map((d) => ({ ...d })),
    });
    await this.db.query(
      `UPDATE meeting_summaries SET summary = $2, decisions = $3::jsonb, risks = $4::jsonb, questions = $5::jsonb WHERE meeting_id = $1`,
      [r.meeting_id, value.summary, JSON.stringify(value.decisions.map((d) => d.text)), JSON.stringify(value.risks),
        JSON.stringify(value.questions.map((q) => q.text))]);
    for (const [i, d] of drafts.entries()) {
      const t = value.tasks[i];
      if (t.title !== d.title || t.description !== d.description || t.quote !== d.quote) {
        await this.db.query(`UPDATE meeting_task_drafts SET title = $2, description = $3, quote = $4 WHERE id = $1`,
          [d.id, t.title.slice(0, 500), t.description, t.quote]);
      }
    }
    // журнал решений: пароль маской; решение о личном — снимаем (это не решение по работе)
    const journal = await this.db.many<{ id: string; text: string; details: string }>(
      `SELECT id::text, text, details FROM decisions WHERE meeting_id = $1 AND revoked_at IS NULL`, [r.meeting_id]);
    for (const j of journal) {
      const text = maskSecrets(j.text);
      const details = maskSecrets(j.details);
      if (text !== j.text || details !== j.details) {
        await this.db.query(`UPDATE decisions SET text = $2, details = $3 WHERE id = $1`, [j.id, text, details]);
      }
    }
  }
}
