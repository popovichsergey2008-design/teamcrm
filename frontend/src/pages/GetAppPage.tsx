import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { api } from '../lib/api';
import type { MobileConfig } from '../lib/mobile-config';
import { humanSize } from '../lib/attachments';
import { platformKind } from '../platform';

type Release = NonNullable<MobileConfig['android']>;

/**
 * Страница «Скачать приложение» — `/get` (ТЗ-9, волна 12).
 *
 * Магазинов нет намеренно (D-03): Android ставится с сайта, iPhone — как веб-приложение
 * с экрана «Домой». Страница открыта без входа: её присылают ссылкой новому сотруднику,
 * у которого пока нет ни учётной записи, ни приложения.
 *
 * Что здесь важно: человек должен понять, что делать, за одно прочтение, и увидеть,
 * что файл настоящий — версия, дата, хэш. Инструкцию про «неизвестные источники» даём
 * заранее: без неё установка обрывается на полпути, и человек решает, что «не работает».
 */
export function GetAppPage() {
  const [release, setRelease] = useState<Release | null | undefined>(undefined);
  const ua = navigator.userAgent;
  const isIos = /iPhone|iPad|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const inApp = platformKind() === 'capacitor';

  useEffect(() => {
    api.mobileRelease().then((r) => setRelease(r.android)).catch(() => setRelease(null));
  }, []);

  return (
    <div className="getapp">
      <div className="auth-logo">
        <Logo size={88} />
        <span className="logo-word">ANTHILL<span className="logo-dot">.</span>TEAM</span>
      </div>
      <p className="dim auth-sub">Приложение для телефона: задачи, чаты, созвоны и уведомления — в кармане.</p>

      {inApp && (
        <div className="card getapp-card getapp-note">
          <Icon name="check" size={16} /> Вы уже в приложении. Обновления приходят сами — уведомлением.
        </div>
      )}

      {/* Android — первым на Android, iPhone — первым на iPhone: человек видит своё сразу. */}
      {[isIos ? 'ios' : 'android', isIos ? 'android' : 'ios'].map((kind) => (kind === 'android' ? (
        <section key="android" className="card getapp-card">
          <h2><Icon name="phone" size={18} /> Android</h2>
          {release === undefined && <p className="dim">Ищем последнюю версию…</p>}
          {release === null && (
            <p className="dim">Приложение ещё не выпущено. Пока откройте anthill.team в браузере телефона — там работает всё то же самое.</p>
          )}
          {release && (
            <>
              <a className="btn btn-primary getapp-download" href={release.apkUrl} download>
                <Icon name="download" size={16} /> Скачать APK · версия {release.latestNative}
                {release.sizeBytes ? <span> · {humanSize(release.sizeBytes)}</span> : null}
              </a>
              {release.notes && <p className="getapp-notes">{release.notes}</p>}
              <ol className="getapp-steps">
                <li>Откройте скачанный файл. Телефон спросит разрешение ставить приложения из браузера — разрешите один раз.</li>
                <li>После установки откройте ANTHILL и войдите своей почтой и паролем.</li>
                <li>Разрешите уведомления — иначе о задачах и звонках вы узнаете только открыв приложение.</li>
              </ol>
              <details className="getapp-verify">
                <summary>Проверить, что файл настоящий</summary>
                <p className="dim">
                  SHA-256 файла{release.publishedAt ? ` (выпуск от ${new Date(release.publishedAt).toLocaleDateString('ru-RU')})` : ''}:
                </p>
                <code className="getapp-sha">{release.sha256}</code>
                <p className="dim">Сравните с тем, что покажет проверка: на Android — приложение «Hash Checker», на компьютере — <code>sha256sum</code> или <code>certutil -hashfile файл SHA256</code>.</p>
              </details>
            </>
          )}
        </section>
      ) : (
        <section key="ios" className="card getapp-card">
          <h2><Icon name="phone" size={18} /> iPhone и iPad</h2>
          <p>Приложение ставится из Safari — без App Store, за три касания:</p>
          <ol className="getapp-steps">
            <li>Откройте <b>anthill.team</b> в Safari (в другом браузере кнопки не будет).</li>
            <li>Нажмите «Поделиться» <Icon name="upload" size={14} /> внизу экрана.</li>
            <li>Выберите «На экран “Домой”» и подтвердите.</li>
          </ol>
          <p className="dim">Значок ANTHILL появится рядом с остальными приложениями и будет открываться на весь экран.</p>
          {isAndroid && <p className="dim">Вы на Android — вам подойдёт установка выше.</p>}
        </section>
      )))}

      <p className="dim getapp-foot">
        Вопросы по установке — в службу заботы прямо из приложения или на сайте: кнопка «Помощь» внизу экрана.
      </p>
    </div>
  );
}
