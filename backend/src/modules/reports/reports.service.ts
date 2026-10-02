import { Injectable } from '@nestjs/common';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { FilesService } from '../files/files.service';
import { renderTaskReportHtml, esc } from './task-report.html';
import { buildTaskReport, TaskReport } from './task-report.model';
import { PdfRenderer } from './pdf.renderer';
import { ReportsRepository } from './reports.repository';

/** Длиннее года отчёт теряет смысл: в нём уже не разобрать ни одной недели. */
const MAX_DAYS = 366;
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface TaskReportQuery {
  from: string;
  to: string;
  projectId?: string | null;
  userId?: string | null;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly repo: ReportsRepository,
    private readonly files: FilesService,
    private readonly pdf: PdfRenderer,
  ) {}

  /**
   * Кто какой отчёт может собрать.
   *
   * Владелец и руководитель — по компании, любому проекту и любому сотруднику.
   * Сотрудник — только свой отчёт (задачи, где он исполнитель): его сдают руководителю
   * за неделю или месяц, а отчёт по коллегам — уже не его дело.
   */
  private scopeFor(user: AuthUser, q: TaskReportQuery): { projectId: string | null; userId: string | null } {
    const manager = user.role === 'owner' || user.role === 'manager';
    const userId = q.userId ? String(q.userId) : null;
    if (!manager) {
      if (userId && userId !== String(user.userId)) throw AppException.forbidden('Отчёт по другому сотруднику собирает руководитель');
      return { projectId: q.projectId ? String(q.projectId) : null, userId: String(user.userId) };
    }
    return { projectId: q.projectId ? String(q.projectId) : null, userId };
  }

  async build(user: AuthUser, q: TaskReportQuery): Promise<TaskReport> {
    if (!DATE_RE.test(q.from ?? '') || !DATE_RE.test(q.to ?? '')) throw AppException.validation('Укажите период: даты «с» и «по»');
    if (q.from > q.to) throw AppException.validation('Дата «с» позже даты «по»');
    const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 + 1;
    if (days > MAX_DAYS) throw AppException.validation('Период не длиннее года');
    if (Number.isNaN(days)) throw AppException.validation('Не понял даты периода');

    const scope = this.scopeFor(user, q);
    const company = await this.repo.company(user.tenantId);
    if (!company) throw AppException.notFound('Компания не найдена');
    const tz = company.timezone || 'Europe/Moscow';

    const [projectRow, personRow, me] = await Promise.all([
      scope.projectId ? this.repo.projectName(user.tenantId, scope.projectId) : null,
      scope.userId ? this.repo.userName(user.tenantId, scope.userId) : null,
      this.repo.userName(user.tenantId, user.userId),
    ]);
    if (scope.projectId && !projectRow) throw AppException.notFound('Проект не найден');
    if (scope.userId && !personRow) throw AppException.notFound('Сотрудник не найден');

    const { start, end } = await this.repo.bounds(q.from, q.to, tz);
    const len = end.getTime() - start.getTime();
    const prevStart = new Date(start.getTime() - len);
    const filter = { tenantId: user.tenantId, ...scope };
    const [tasks, hours, tracksTime, logo] = await Promise.all([
      this.repo.tasks(filter, end, prevStart),
      this.repo.hours(filter, start, end, prevStart),
      this.repo.tracksTime(user.tenantId),
      this.logo(user.tenantId, company.logo_file_id),
    ]);

    return buildTaskReport({
      companyName: company.name, logoDataUri: logo, timezone: tz,
      from: q.from, to: q.to, start, end, prevStart, prevEnd: start, now: new Date(),
      generatedBy: me?.full_name ?? '',
      scope: { projectName: projectRow?.name ?? null, personName: personRow?.full_name ?? null },
      tasks, hours, tracksTime,
    });
  }

  /** Короткая сводка для экрана — те же цифры, что в PDF, чтобы до скачивания было видно, что внутри. */
  async summary(user: AuthUser, q: TaskReportQuery) {
    const r = await this.build(user, q);
    return {
      periodLabel: r.periodLabel, prevLabel: r.prevLabel, scopeLabel: r.scopeLabel, ongoing: r.ongoing, empty: r.empty,
      kpis: r.kpis, insights: r.insights,
      counts: { completed: r.completedTotal, overdue: r.overdueTotal, soon: r.soon.length, review: r.review.length },
    };
  }

  async pdfFile(user: AuthUser, q: TaskReportQuery): Promise<{ buffer: Buffer; fileName: string; asciiName: string }> {
    const r = await this.build(user, q);
    const footer = `<div style="font-family:Inter,'DejaVu Sans',sans-serif;font-size:7px;width:100%;padding:0 12mm;color:#94a3b8;display:flex;justify-content:space-between">
      <span>${esc(r.companyName)} · ${esc(r.title)} · ${esc(r.periodLabel)} · ${esc(r.scopeLabel)}</span>
      <span>стр. <span class="pageNumber"></span> из <span class="totalPages"></span></span></div>`;
    const buffer = await this.pdf.render(renderTaskReportHtml(r), footer);
    const who = r.scopeLabel === 'Вся компания' ? '' : ` — ${r.scopeLabel.replace(/[«»"]/g, '')}`;
    return {
      buffer,
      fileName: `Отчёт по задачам — ${r.periodLabel}${who}.pdf`.replace(/[\\/:*?"<>|]/g, ' '),
      asciiName: `anthill-tasks-report-${q.from}_${q.to}.pdf`,
    };
  }

  /** Логотип компании прямо в отчёт: data-URI, потому что печать идёт без сети. */
  private async logo(tenantId: string, fileId: string | null): Promise<string | null> {
    if (!fileId) return null;
    try {
      const { file, stream } = await this.files.getForDownload(tenantId, fileId);
      if (!String(file.content_type).startsWith('image/') || Number(file.size_bytes) > LOGO_MAX_BYTES) return null;
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.from(c));
      return `data:${file.content_type};base64,${Buffer.concat(chunks).toString('base64')}`;
    } catch {
      return null; // без логотипа отчёт всё равно нужен
    }
  }
}
