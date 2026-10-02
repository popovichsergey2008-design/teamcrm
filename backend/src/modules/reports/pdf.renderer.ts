import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/http/app-exception';

/** Одновременно печатаем не больше стольких PDF: Chromium на каждый — сотни мегабайт. */
const MAX_PARALLEL = 2;
const RENDER_TIMEOUT_MS = 45_000;

/**
 * HTML → PDF настоящим Chromium.
 *
 * Почему браузер, а не библиотека вроде pdfkit: отчёт — это вёрстка (сетки, графики,
 * таблицы, которые не рвутся на середине строки), и в браузере она выходит такой же,
 * как задумана, а в pdfkit пришлось бы рисовать каждую линию координатами.
 *
 * Браузер поднимаем на каждый отчёт и сразу закрываем: отчёты редкие, а постоянно
 * живущий Chromium в контейнере API — это память, которая нужна созвонам.
 */
@Injectable()
export class PdfRenderer {
  private readonly log = new Logger('PdfRenderer');
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly config: ConfigService) {}

  private async slot(): Promise<() => void> {
    if (this.running >= MAX_PARALLEL) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    return () => { this.running--; this.queue.shift()?.(); };
  }

  async render(html: string, footer: string): Promise<Buffer> {
    const release = await this.slot();
    // puppeteer-core грузим лениво: тестам и большинству запросов он не нужен
    const puppeteer = await import('puppeteer-core');
    const executablePath = this.config.get<string>('CHROMIUM_PATH') || '/usr/bin/chromium';
    let browser: import('puppeteer-core').Browser | null = null;
    const started = Date.now();
    try {
      browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
        timeout: RENDER_TIMEOUT_MS,
      });
      const page = await browser.newPage();
      // ничего внешнего: всё нужное лежит в самом HTML, а сеть отчёту не нужна
      await page.setRequestInterception(true);
      page.on('request', (req) => (req.url().startsWith('data:') || req.url() === 'about:blank' ? req.continue() : req.abort()));
      await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: footer,
        timeout: RENDER_TIMEOUT_MS,
      });
      this.log.log(`PDF ${Math.round(pdf.length / 1024)} КБ за ${Date.now() - started} мс`);
      return Buffer.from(pdf);
    } catch (e) {
      this.log.error(`PDF не собрался: ${(e as Error).message}`);
      throw new AppException('INTERNAL', 'Не удалось собрать PDF — попробуйте ещё раз через минуту');
    } finally {
      await browser?.close().catch(() => undefined);
      release();
    }
  }
}
