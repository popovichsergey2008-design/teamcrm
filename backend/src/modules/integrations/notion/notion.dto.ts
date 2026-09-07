import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class ConnectNotionDto {
  /** Токен внутренней интеграции с notion.so/my-integrations. */
  @IsString()
  @MaxLength(200)
  token!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class ImportNotionDto {
  @IsArray()
  @IsString({ each: true })
  databaseIds!: string[];
}

export class MapNotionUserDto {
  @IsString()
  @MaxLength(64)
  externalUserId!: string;

  @IsString()
  @MaxLength(32)
  localUserId!: string;
}
