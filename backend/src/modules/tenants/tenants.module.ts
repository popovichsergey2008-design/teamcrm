import { Module } from '@nestjs/common';
import { TenantsRepository } from './tenants.repository';

@Module({
  providers: [TenantsRepository],
  exports: [TenantsRepository],
})
export class TenantsModule {}
