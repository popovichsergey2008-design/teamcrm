import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { cleanTask, DemoTask, ogHtml, scrub } from './demo-share.rules';

const ABC = 'abcdefghjkmnpqrstuvwxyz23456789';
/** Не больше 10 ссылок с адреса в час: страница открыта всем, вход не нужен. */
const PER_HOUR = 10;

/**
 * «Отправить коллеге» (#4863): результат демо с главной — по ссылке qevo.one/demo/<код>.
 * Хранится 30 дней, без личных данных (контакты вырезаются до записи), адрес IP не
 * пишется. Картинка превью — та же карточка, снимок Chromium, считается один раз.
 */
@Injectable()
export class DemoShareService {
  private readonly log = new Logger('DemoShare');
  private readonly hits = new Map<string, number[]>();
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: DbService, private readonly config: ConfigService) {}

  private allow(ip: string, now = Date.now()) {
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= PER_HOUR) return false;
    recent.push(now);
    this.hits.set(ip, recent);
    if (this.hits.size > 5000) this.hits.clear();
    return true;
  }

  async create(input: { message: unknown; task: unknown }, ip: string) {
    if (!this.allow(ip)) throw new AppException('RATE_LIMITED', 'Слишком много ссылок — попробуйте через час');
    const task = cleanTask(input.task);
    const message = scrub(input.message, 1000);
    if (!task || message.length < 3) throw AppException.validation('Нечем поделиться: сначала поставьте задачу в демо');
    await this.db.query(`DELETE FROM demo_shares WHERE expires_at < now()`).catch(() => undefined);
    let code = '';
    for (let i = 0; i < 5 && !code; i++) {
      const next = Array.from({ length: 8 }, () => ABC[randomInt(ABC.length)]).join('');
      const r = await this.db.one<{ code: string }>(
        `INSERT INTO demo_shares (code, message, task) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING RETURNING code`,
        [next, message, JSON.stringify(task)]);
      code = r?.code ?? '';
    }
    if (!code) throw AppException.conflict('Не удалось создать ссылку — попробуйте ещё раз');
    void this.renderOg(code, task);
    const base = 'https://qevo.one';
    return { code, url: `${base}/demo/${code}?utm_source=share&utm_medium=demo` };
  }

  async get(code: string) {
    if (!/^[a-z0-9]{6,12}$/.test(code)) return null;
    const r = await this.db.one<{ code: string; message: string; task: DemoTask }>(
      `UPDATE demo_shares SET views = views + 1 WHERE code = $1 AND expires_at > now() RETURNING code, message, task`, [code]);
    return r;
  }

  async og(code: string): Promise<Buffer | null> {
    if (!/^[a-z0-9]{6,12}$/.test(code)) return null;
    const r = await this.db.one<{ og_png: Buffer | null; task: DemoTask }>(
      `SELECT og_png, task FROM demo_shares WHERE code = $1 AND expires_at > now()`, [code]);
    if (!r) return null;
    return r.og_png ?? this.renderOg(code, r.task);
  }

  /** Снимок карточки 1200×630; страница без сети и без скриптов — только наша разметка. */
  private renderOg(code: string, task: DemoTask): Promise<Buffer | null> {
    const run = this.busy.then(() => this.shoot(code, task), () => this.shoot(code, task));
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async shoot(code: string, task: DemoTask): Promise<Buffer | null> {
    let browser: import('puppeteer-core').Browser | null = null;
    try {
      const puppeteer = await import('puppeteer-core');
      browser = await puppeteer.launch({
        executablePath: this.config.get<string>('CHROMIUM_PATH') || '/usr/bin/chromium',
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none', '--lang=ru-RU'],
        timeout: 20_000,
      });
      const page = await browser.newPage();
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on('request', (req) => { if (req.url().startsWith('data:') || req.url() === 'about:blank') void req.continue(); else void req.abort('blockedbyclient'); });
      await page.setViewport({ width: 1200, height: 630 });
      await page.setContent(ogHtml(task), { waitUntil: 'load', timeout: 10_000 });
      const png = Buffer.from(await page.screenshot({ type: 'png' }));
      await this.db.query(`UPDATE demo_shares SET og_png = $2 WHERE code = $1`, [code, png]);
      return png;
    } catch (e) {
      this.log.warn(`превью ${code}: ${(e as Error).message}`);
      return null;
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }
}
