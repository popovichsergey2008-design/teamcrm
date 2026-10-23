import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { checkUrl, isPrivateIp, UnsafeUrlError } from '../../common/net/safe-fetch';

const SHOT_TIMEOUT_MS = 25_000;
const VIEWPORT = { width: 1280, height: 800 };
/** Выше этого не снимаем: длинная страница целиком — это рулон, а не «как стало». */
const MAX_HEIGHT = 2400;

/**
 * Можно ли браузеру идти по этому адресу.
 *
 * Проверка та же, что у `safeFetch` (ТЗ-33), но здесь запросы делает не наш код, а
 * Chromium — свой `lookup` ему не подсунешь. Поэтому каждый запрос страницы
 * (документ, перенаправление, картинка, скрипт) перехватываем и пускаем, только если
 * ссылка обычная, а ВСЕ адреса имени — внешние. Остаётся окно в миллисекунды между
 * нашей проверкой и соединением браузера (DNS rebinding); его принимаем осознанно:
 * результат — картинка, текст страницы никуда не уходит.
 */
export async function urlAllowed(raw: string, resolve: (host: string) => Promise<string[]> = defaultResolve): Promise<boolean> {
  if (raw.startsWith('data:') || raw === 'about:blank') return true;
  let u: URL;
  try { u = checkUrl(raw); } catch { return false; }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return !isPrivateIp(host);
  try {
    const addrs = await resolve(host);
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a));
  } catch {
    return false;
  }
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((a) => a.address);
}

/**
 * Снимок страницы сайта (#4657): «стало» для задачи, где исполнитель ничего не приложил,
 * но в задаче есть адрес. Тот же Chromium, что печатает PDF-отчёты; поднимаем на снимок
 * и сразу закрываем — память контейнера нужна созвонам.
 */
@Injectable()
export class PageShooter {
  private readonly log = new Logger('PageShot');
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: ConfigService) {}

  /** Снимок или null с причиной: страница не открылась — это не повод ронять отчёт. */
  shoot(url: string): Promise<{ jpeg: Buffer; finalUrl: string } | { error: string }> {
    // строго по одному: два Chromium разом — сотни мегабайт сверх созвонов
    const run = this.busy.then(() => this.shootNow(url), () => this.shootNow(url));
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async shootNow(url: string): Promise<{ jpeg: Buffer; finalUrl: string } | { error: string }> {
    try { checkUrl(url); } catch (e) { return { error: (e as Error).message }; }
    if (!(await urlAllowed(url))) return { error: 'Адрес ведёт во внутреннюю сеть — не открываем' };

    let puppeteer: typeof import('puppeteer-core');
    try { puppeteer = await import('puppeteer-core'); } catch { return { error: 'Браузер для снимков недоступен' }; }
    const executablePath = this.config.get<string>('CHROMIUM_PATH') || '/usr/bin/chromium';
    let browser: import('puppeteer-core').Browser | null = null;
    try {
      browser = await puppeteer.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none', '--lang=ru-RU'],
        timeout: SHOT_TIMEOUT_MS,
      });
      const page = await browser.newPage();
      await page.setViewport(VIEWPORT);
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        void urlAllowed(req.url())
          .then((ok) => (ok ? req.continue() : req.abort('blockedbyclient')))
          .catch(() => req.abort('blockedbyclient').catch(() => undefined));
      });
      // загрузки файлов, всплывающие окна и диалоги снимку не нужны
      page.on('dialog', (d) => { void d.dismiss().catch(() => undefined); });
      const res = await page.goto(url, { waitUntil: 'networkidle2', timeout: SHOT_TIMEOUT_MS }).catch((e: Error) => {
        // сеть не утихла (вечный опрос, чат-виджет) — снимаем то, что успело загрузиться
        if (/timeout/i.test(e.message)) return null;
        throw e;
      });
      const finalUrl = page.url();
      if (!finalUrl.startsWith('http')) return { error: 'Страница не открылась' };
      const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => VIEWPORT.height);
      const jpeg = await page.screenshot({
        type: 'jpeg', quality: 82,
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: Math.min(Math.max(Number(height) || VIEWPORT.height, VIEWPORT.height), MAX_HEIGHT) },
        captureBeyondViewport: true,
      });
      if (res && res.status() >= 400) this.log.warn(`снимок ${finalUrl}: сайт ответил ${res.status()}`);
      return { jpeg: Buffer.from(jpeg), finalUrl };
    } catch (e) {
      const msg = e instanceof UnsafeUrlError ? e.message : 'Страница не открылась';
      this.log.warn(`снимок ${url}: ${(e as Error).message}`);
      return { error: msg };
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }
}
