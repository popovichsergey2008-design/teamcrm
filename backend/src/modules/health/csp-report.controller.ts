import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/auth/decorators';

const PER_MINUTE = 60;

/**
 * Отчёты браузера о нарушениях политики содержимого (CSP).
 *
 * Полная политика пока стоит «в режиме отчёта» (frontend/nginx-security.conf): браузер
 * ничего не блокирует, а сообщает сюда, что бы он заблокировал. По журналу видно, каких
 * адресов не хватает, прежде чем включать политику по-настоящему и ломать людям экраны.
 * Тело — от браузера, произвольное: пишем только адреса и директиву, не больше 60 в минуту.
 */
@ApiExcludeController()
@Controller('csp-report')
export class CspReportController {
  private readonly log = new Logger('CSP');
  private windowStart = 0;
  private count = 0;

  @Public()
  @Post()
  @HttpCode(204)
  report(@Body() body: Record<string, any>) {
    const now = Date.now();
    if (now - this.windowStart > 60_000) { this.windowStart = now; this.count = 0; }
    if (++this.count > PER_MINUTE) return;
    // старый формат {csp-report:{…}} и новый Reporting API [{type, body:{…}}]
    const items: any[] = Array.isArray(body) ? body.map((r) => r?.body ?? r) : [body?.['csp-report'] ?? body];
    for (const r of items.slice(0, 5)) {
      const directive = String(r?.['effective-directive'] ?? r?.effectiveDirective ?? r?.['violated-directive'] ?? '?').slice(0, 60);
      const blocked = String(r?.['blocked-uri'] ?? r?.blockedURL ?? '?').slice(0, 200);
      const page = String(r?.['document-uri'] ?? r?.documentURL ?? '?').split('?')[0].slice(0, 200);
      this.log.warn(`нарушение ${directive}: ${blocked} на ${page}`);
    }
  }
}
