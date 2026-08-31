import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
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
