import { Module } from '@nestjs/common';
import { PositionsRepository } from './positions.repository';
import { PositionsController } from './positions.controller';
import { GroupsRepository } from './groups.repository';
import { GroupsController } from './groups.controller';

/** Справочники команды (должности, группы/отделы). Без зависимостей → используется UsersModule. */
@Module({
  controllers: [PositionsController, GroupsController],
  providers: [PositionsRepository, GroupsRepository],
  exports: [PositionsRepository, GroupsRepository],
})
export class TeamModule {}
