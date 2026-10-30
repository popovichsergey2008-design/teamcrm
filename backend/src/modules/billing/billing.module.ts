import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BillingController } from './billing.controller';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { ReadOnlyInterceptor } from './read-only.interceptor';

/** Подписка и оплата (ЮKassa). Global: места по тарифу проверяют приглашения и команда. */
@Global()
@Module({
  controllers: [BillingController],
  providers: [BillingRepository, BillingService, { provide: APP_INTERCEPTOR, useClass: ReadOnlyInterceptor }],
  exports: [BillingService],
})
export class BillingModule {}
