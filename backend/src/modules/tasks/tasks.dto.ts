import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
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

export class MoveTaskDto {
  @IsString()
  columnId!: string;

  @IsInt()
  @Min(0)
  position!: number;
}
