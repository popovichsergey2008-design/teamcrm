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
}

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  managerId?: string | null;

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
}
