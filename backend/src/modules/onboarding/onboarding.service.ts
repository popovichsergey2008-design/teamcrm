import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { INDUSTRIES, industryByCode } from './industries';
import { buildSteps, isComplete, nextStep, OnboardingStep, progress, StepKey } from './onboarding-steps';
import { OnboardingRepository } from './onboarding.repository';

export interface OnboardingView {
  steps: OnboardingStep[];
  done: number;
  total: number;
  completed: boolean;
  /** Подсказка убрана совсем: показывать её не надо, но открыть из настроек можно. */
  dismissed: boolean;
  /** Куда звать дальше; null — звать больше некуда. */
  next: StepKey | null;
  company: { name: string; timezone: string; industry: string | null; logoFileId: string | null };
}

/**
 * Путь владельца от регистрации до первой задачи (ТЗ-11).
 *
 * Здесь нет мастера, который ведёт за руку и блокирует остальное. Подсказка показывает,
 * что уже сделано и что осталось, — а идти человек может любым порядком и мимо неё:
 * шаги считаются по факту (см. `onboarding-steps.ts`).
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly repo: OnboardingRepository) {}

  /** Состояние пути. Строку заводим на лету: организации бывают старше этого кода. */
  async view(tenantId: string, userId: string): Promise<OnboardingView> {
    await this.repo.ensure(tenantId, userId);
    const [state, facts, company] = await Promise.all([
      this.repo.state(tenantId),
      this.repo.facts(tenantId, userId),
      this.repo.company(tenantId),
    ]);

    const steps = buildSteps(
      { ...facts, companyConfirmed: !!state?.company_confirmed_at },
      state?.skipped ?? [],
    );
    const completed = isComplete(steps);
    // Отмечаем завершение, как только оно случилось: иначе «завершено» жило бы только
    // в текущем ответе и подсказка возвращалась бы при каждом входе.
    if (completed && !state?.completed_at) await this.repo.markCompleted(tenantId);

    const { done, total } = progress(steps);
    return {
      steps,
      done,
      total,
      completed,
      dismissed: !!state?.dismissed,
      next: nextStep(steps)?.key ?? null,
      company: {
        name: company?.name ?? '',
        timezone: company?.timezone ?? 'Europe/Moscow',
        industry: company?.industry ?? null,
        logoFileId: company?.logo_file_id ?? null,
      },
    };
  }

  /** Список отраслей с отделами: по нему рисуется шаг «Создать отделы». */
  industries() {
    return INDUSTRIES;
  }

  /**
   * Что предложить отметить для отрасли — с поправкой на уже заведённое.
   *
   * Отдел, который в организации уже есть, приходит отмеченным и как существующий:
   * человек должен видеть, что его не заведут повторно, а не гадать.
   */
  async departmentSuggestion(tenantId: string, code: string | null) {
    const industry = industryByCode(code);
    const existing = new Set((await this.repo.departmentNames(tenantId)).map((n) => n.toLowerCase()));
    return {
      industry: industry.code,
      title: industry.title,
      departments: industry.departments.map((d) => ({
        name: d.name,
        checked: d.common || existing.has(d.name.toLowerCase()),
        exists: existing.has(d.name.toLowerCase()),
      })),
    };
  }

  /** Завести отмеченные отделы. Возвращаем, сколько появилось новых. */
  async createDepartments(tenantId: string, names: string[]): Promise<{ created: number }> {
    const clean = [...new Set(
      names.map((n) => String(n ?? '').trim()).filter((n) => n.length >= 2 && n.length <= 96),
    )];
    if (!clean.length) throw AppException.validation('Выберите хотя бы один отдел');
    return { created: await this.repo.addDepartments(tenantId, clean) };
  }

  /**
   * Сохранить настройки компании и закрыть шаг.
   *
   * Подтверждение отмечаем ровно здесь: у пояса есть значение по умолчанию, и «человек
   * посмотрел и согласился» от «никогда не открывал» иначе не отличить.
   */
  async saveCompany(
    tenantId: string,
    patch: { name?: string; timezone?: string; industry?: string | null; logoFileId?: string | null },
  ): Promise<void> {
    if (patch.industry && !INDUSTRIES.some((i) => i.code === patch.industry)) {
      throw AppException.validation('Неизвестная отрасль');
    }
    await this.repo.saveCompany(tenantId, patch);
    await this.repo.confirmCompany(tenantId);
  }

  async skip(tenantId: string, step: StepKey): Promise<void> {
    // Обязательные шаги отложить нельзя: без проекта и задачи системой не пользуются,
    // и «позже» здесь означало бы «никогда».
    const required: StepKey[] = ['workspace', 'project', 'task'];
    if (required.includes(step)) throw AppException.validation('Этот шаг не пропускается');
    await this.repo.skip(tenantId, step);
  }

  async setDismissed(tenantId: string, dismissed: boolean): Promise<void> {
    await this.repo.setDismissed(tenantId, dismissed);
  }
}
