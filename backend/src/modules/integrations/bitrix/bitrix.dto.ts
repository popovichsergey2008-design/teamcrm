import { IsArray, IsBoolean, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class ConnectBitrixDto {
  @IsString()
  @MaxLength(500)
  webhookUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class ImportBitrixDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  projectExternalIds?: string[];

  // импортировать общую Живую ленту компании в служебный контейнер «Входящие из Битрикса»
  @IsOptional()
  @IsBoolean()
  includeGeneralFeed?: boolean;
}

export class UngroupedAssignmentDto {
  @IsString()
  externalId!: string;

  // id проекта-получателя; null/пусто → «Входящие из Битрикса»
  @IsOptional()
  @IsString()
  projectId?: string | null;
}

export class ApplyUngroupedDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UngroupedAssignmentDto)
  assignments!: UngroupedAssignmentDto[];
}

export class MapUserDto {
  @IsString()
  externalUserId!: string;

  @IsString()
  localUserId!: string;
}
