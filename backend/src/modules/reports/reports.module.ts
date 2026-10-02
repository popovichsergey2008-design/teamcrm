import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { PdfRenderer } from './pdf.renderer';
import { ReportsController } from './reports.controller';
import { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

@Module({
  imports: [FilesModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportsRepository, PdfRenderer],
})
export class ReportsModule {}
