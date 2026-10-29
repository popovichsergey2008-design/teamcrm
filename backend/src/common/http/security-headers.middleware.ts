import { NextFunction, Request, Response } from 'express';

/**
 * Заголовки безопасности ответов API (мастер-план релиза §27).
 *
 * Страницы приложения получают свои заголовки от веб-контейнера (frontend/nginx-security.conf);
 * здесь — то, что касается самих ответов API:
 *  - nosniff: браузер не угадывает тип — загруженный «картинкой» html не исполнится;
 *  - SAMEORIGIN: файл из /api/files можно показать в рамке только у себя (предпросмотр PDF),
 *    чужой сайт встроить его не сможет;
 *  - no-store у входа: токены и коды не должны оседать в кэше браузера или прокси.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path.includes('/auth/')) res.setHeader('Cache-Control', 'no-store');
  next();
}
