import { Global, Module } from '@nestjs/common';
import { PolicyConsentsService } from './policy-consents.service';

/**
 * Политики и согласия с ними (#4675). Глобальный: журнал пишут регистрация, приглашения,
 * вход через Google и служба заботы — тянуть модуль в каждый из них незачем.
 */
@Global()
@Module({
  providers: [PolicyConsentsService],
  exports: [PolicyConsentsService],
})
export class LegalModule {}
