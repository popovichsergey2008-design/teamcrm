import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateTaskDto {
  @IsString()
  projectId!: string;

  @IsOptional()
  @IsString()
  columnId?: string; // по умолчанию — первая колонка проекта

  @IsString()
  @MaxLength(255)
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  assigneeId?: string;

  @IsOptional()
  @IsString()
  managerId?: string;

  // Ниже — поля, которые раньше можно было задать только в открытой карточке.
  // Форма создания должна уметь то же самое, иначе задачу приходится доводить в два захода.
  @IsOptional()
  @IsIn(['low', 'normal', 'high', 'urgent'])
  priority?: string;

  @IsOptional()
  @IsString()
  deadlineAt?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  estimateHours?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labelIds?: string[];

  /**
   * Не завершать без согласования с постановщиком. Умолчание — включено:
   * это поведение, которое команды и так имитируют вручную («напиши, когда закончишь»).
   */
  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  /** Пункты чек-листа, если задачу собрали заранее — голосом или из встречи. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  checklist?: string[];

  /** Кто делает работу вместе с исполнителем. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  coAssigneeIds?: string[];

  /** Кто следит за задачей, но не выполняет её. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  watcherIds?: string[];
}

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  managerId?: string | null;

  /** Постановщик может включить или снять согласование, пока задача не завершена. */
  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  assigneeId?: string | null;

  @IsOptional()
  @IsBoolean()
  isBlocked?: boolean;

  @IsOptional()
  @IsIn(['low', 'normal', 'high', 'urgent'])
  priority?: string;
}

/** План на день. null — снять план (задача уходит из «сегодня», срок при этом не трогаем). */
export class FocusDateDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Дата в формате ГГГГ-ММ-ДД' })
  date?: string | null;
}

export class MoveTaskDto {
  @IsString()
  columnId!: string;

  @IsInt()
  @Min(0)
  position!: number;

  /** «Сдать всё равно»: человек увидел, чего не хватает, и решил сдавать. */
  @IsOptional()
  @IsBoolean()
  confirmGate?: boolean;
}

/** Возврат в работу: причина обязательна — «переделай» без объяснения бесполезно. */
export class ReturnTaskDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class ApprovalRequiredDto {
  @IsBoolean()
  enabled!: boolean;
}

/** Кого и кем добавляем к задаче. */
export class ParticipantDto {
  @IsString()
  @MaxLength(32)
  userId!: string;

  @IsIn(['co_assignee', 'watcher'])
  role!: 'co_assignee' | 'watcher';
}

/**
 * Фильтры реестра задач.
 *
 * Валидация здесь не формальность: `forbidNonWhitelisted` отклонит незнакомый параметр,
 * а белые списки не дадут подставить произвольное значение в срез или сортировку —
 * дальше эти строки попадают в текст SQL (значения фильтров идут параметрами).
 *
 * `closed` и `dayEnd` приходят строками: это query-параметры, а не тело запроса.
 */
export class TaskRegistryQueryDto {
  /**
   * Срез реестра. `mine` оставлен рядом с новыми `doing`/`helping`: по нему приходят
   * ссылки, сохранённые до разделения «делаю» и «помогаю», и отвечать на них 400 нельзя.
   */
  @IsOptional()
  @IsIn(['doing', 'helping', 'mine', 'delegated', 'watching', 'all'])
  scope?: 'doing' | 'helping' | 'mine' | 'delegated' | 'watching' | 'all';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  projectId?: string;

  /** Идентификатор либо `none` — «без исполнителя». */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  assigneeId?: string;

  @IsOptional()
  @IsIn(['urgent', 'high', 'normal', 'low'])
  priority?: string;

  @IsOptional()
  @IsIn(['any', 'overdue', 'today', 'week', 'none'])
  due?: string;

  @IsOptional()
  @IsIn(['deadline', 'created', 'updated', 'priority', 'project'])
  sort?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  closed?: string;

  /*
    Приведение типа задано явно, а не оставлено на enableImplicitConversion: этот
    параметр включён только в main.ts, и в тестах тот же DTO получал строку «2» —
    запрос отклонялся с 400 там, где в проде работал. Такое расхождение находится
    не сразу, поэтому число разбираем здесь.
  */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** Конец «сегодня» у пользователя, ISO. Без него «просрочено» считается по серверу. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  dayEnd?: string;
}

/**
 * Расписание повтора задачи.
 *
 * Проверяем здесь только форму («число, строка, из списка»), а смысл — в
 * `normalizeRule`: «еженедельно без дней недели» формально корректно, а работать
 * не может. Разводить эти две проверки по разным местам нельзя — они разъедутся.
 */
export class TaskRecurrenceDto {
  @IsIn(['daily', 'weekly', 'monthly', 'days'])
  freq!: 'daily' | 'weekly' | 'monthly' | 'days';

  /** 1 = понедельник … 7 = воскресенье. */
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  weekdays?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  monthday?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  intervalDays?: number;

  /** «ЧЧ:ММ» местного времени. */
  @IsString()
  @MaxLength(5)
  atTime!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  tz?: string;
}

/**
 * Объединение задач.
 *
 * Основную задачу выбирает человек, поэтому сторона приходит уже разобранной:
 * `primaryId` остаётся, `secondaryId` получает пометку «объединена».
 *
 * Название, описание и чек-лист необязательны — их присылают, только если человек
 * принял предложение ИИ или поправил его. Пусто — данные основной задачи не трогаем.
 */
export class MergeTasksDto {
  @IsString() primaryId!: string;
  @IsString() secondaryId!: string;
  @IsOptional() @IsString() @MaxLength(255) title?: string;
  @IsOptional() @IsString() @MaxLength(8000) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) checklist?: string[];
}
