import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class ConnectTrelloDto {
  /** Ключ берётся на trello.com/power-ups/admin, токен — по ссылке авторизации. */
  @IsString()
  @MaxLength(120)
  apiKey!: string;

  @IsString()
  @MaxLength(200)
  token!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class ImportTrelloDto {
  @IsArray()
  @IsString({ each: true })
  boardIds!: string[];
}

export class MapTrelloUserDto {
  @IsString()
  @MaxLength(64)
  externalUserId!: string;

  @IsString()
  @MaxLength(32)
  localUserId!: string;
}
