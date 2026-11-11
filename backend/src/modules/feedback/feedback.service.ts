import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { FilesService } from '../files/files.service';
import { SupportDeskService } from '../support/support-desk.service';
import { NpsStateService } from './nps-state.service';

type User = { userId: string; tenantId: string; role: string };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Оценка и отзывы (ТЗ 10.11). 9–10 — пригласить коллег и попросить отзыв для сайта;
 * 0–6 — «Что улучшить?», ответ уходит в службу заботы; отзыв со вкладки профиля и из
 * опроса — письмом тому, кто ведёт сайт (REVIEWS_EMAIL, по умолчанию info@qevo.one).
 */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly db: DbService,
    private readonly state: NpsStateService,
    private readonly desk: SupportDeskService,
    private readonly files: FilesService,
    private readonly config: ConfigService,
  ) {}

  async due(u: User): Promise<{ due: boolean }> {
    return { due: await this.state.claim(u.tenantId, u.userId) };
  }

  async answer(u: User, dto: { score: number; improve?: string; review?: string; consent?: boolean }) {
    const score = Math.round(Number(dto.score));
    if (!Number.isFinite(score) || score < 0 || score > 10) throw AppException.validation('Оценка — от 0 до 10');
    const improve = clean(dto.improve, 2000) || null;
    const review = clean(dto.review, 3000);
    if (score >= 9 && review && dto.consent !== true) throw AppException.validation('Отметьте согласие на публикацию отзыва');
    await this.db.query(`INSERT INTO nps_answers (tenant_id, user_id, score, improve) VALUES ($1, $2, $3, $4)`, [u.tenantId, u.userId, score, improve]);
    // 0–6: «Что улучшить?» — в службу заботы, чтобы ответил живой человек
    if (score <= 6 && improve) {
      await this.desk.send(u.tenantId, u, `Оценка QEVO: ${score} из 10. Что улучшить: ${improve}`).catch(() => undefined);
    }
    if (score >= 9 && review) {
      const me = await this.me(u);
      await this.saveReview(u, { name: me.name, position: null, company: me.company, text: review, photoFileId: null, source: 'nps', score });
    }
    return { ok: true };
  }

  async review(u: User, dto: { name: string; position?: string; company?: string; text: string; photoFileId?: string | null; consent: boolean }) {
    const name = clean(dto.name, 120);
    const text = clean(dto.text, 3000);
    if (!name) throw AppException.validation('Укажите имя');
    if (text.length < 10) throw AppException.validation('Напишите отзыв — хотя бы пару предложений');
    if (dto.consent !== true) throw AppException.validation('Отметьте согласие на публикацию отзыва на qevo.one');
    let photo: string | null = null;
    if (dto.photoFileId) {
      const f = await this.files.meta(u.tenantId, String(dto.photoFileId));
      if (!f || !/^image\//.test(f.content_type)) throw AppException.validation('Фото — картинка JPG, PNG или WEBP');
      photo = String(dto.photoFileId);
    }
    await this.saveReview(u, {
      name, position: clean(dto.position, 120) || null, company: clean(dto.company, 160) || null,
      text, photoFileId: photo, source: 'profile', score: null,
    });
    return { ok: true };
  }

  private async me(u: User): Promise<{ name: string; company: string | null }> {
    const r = await this.db.one<{ full_name: string; tenant: string }>(
      `SELECT u.full_name, t.name AS tenant FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1 AND u.tenant_id = $2`,
      [u.userId, u.tenantId],
    );
    return { name: r?.full_name ?? 'Пользователь QEVO', company: r?.tenant ?? null };
  }

  private async saveReview(u: User, r: {
    name: string; position: string | null; company: string | null; text: string; photoFileId: string | null; source: string; score: number | null;
  }) {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO site_reviews (tenant_id, user_id, name, position, company, body, photo_file_id, consent, source, score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9) RETURNING id::text`,
      [u.tenantId, u.userId, r.name, r.position, r.company, r.text, r.photoFileId, r.source, r.score],
    );
    const to = String(this.config.get('REVIEWS_EMAIL') ?? '').trim() || 'info@qevo.one';
    const who = [r.name, r.position, r.company].filter(Boolean).join(', ');
    const photo = r.photoFileId ? this.files.signPlay(u.tenantId, r.photoFileId, 30 * 86_400).url : null;
    const lines = [
      `Новый отзыв для qevo.one${r.score != null ? ` (оценка ${r.score} из 10)` : ''}. Согласие на публикацию — есть.`,
      '', `Кто: ${who}`, '', r.text, ...(photo ? ['', `Фото (ссылка на 30 дней): ${photo}`] : []),
    ];
    await this.db.query(
      `INSERT INTO mail_outbox (tenant_id, user_id, to_email, subject, body_text, body_html, event_key, dedup_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'feedback.review', $7) ON CONFLICT (dedup_key) DO NOTHING`,
      [u.tenantId, u.userId, to, `Отзыв для сайта: ${who}`.slice(0, 255), lines.join('\n'),
        `<p>${lines.map((l) => esc(l)).join('<br>')}</p>`, `feedback.review:${row?.id}`],
    );
  }
}
