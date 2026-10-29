/**
 * Письма входа: подтверждение почты и смена пароля.
 *
 * Отдельно от писем о задачах (notifications/mail.templates.ts): у тех каркас — карточка
 * задачи и ссылка «Отписаться», а от этих писем не отписываются. Вёрстка та же по духу:
 * таблицы и стили в атрибутах — всё, что одинаково читают Gmail и Outlook.
 */
export interface AuthLetter {
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function shell(o: { preheader: string; title: string; lead: string; button: string; url: string; note: string }): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>QEVO</title></head>
<body style="margin:0;padding:0;background:#f5f1ea;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(o.preheader)}</div>
<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%;background:#f5f1ea">
  <tr><td align="center" style="padding:28px 12px">
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%;max-width:520px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif">
      <tr><td style="padding:0 4px 14px">
        <span style="font-size:20px;font-weight:800;letter-spacing:.5px;color:#193b91">QEVO</span>
      </td></tr>
      <tr><td style="background:#fffefb;border:1px solid #e3dcd0;border-radius:12px;padding:24px 26px">
        <p style="margin:0 0 12px;font-size:19px;line-height:1.35;font-weight:700;color:#211d18">${esc(o.title)}</p>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.55;color:#544c41">${esc(o.lead)}</p>
        <table cellpadding="0" cellspacing="0" border="0" role="presentation">
          <tr><td style="background:#0a6bb0;border-radius:8px">
            <a href="${esc(o.url)}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">${esc(o.button)}</a>
          </td></tr>
        </table>
        <p style="margin:20px 0 0;font-size:12px;line-height:1.55;color:#7a7064">${esc(o.note)}</p>
      </td></tr>
      <tr><td style="padding:16px 6px 0;font-size:12px;line-height:1.6;color:#7a7064">
        Письмо от QEVO. Если вы ничего не запрашивали — просто удалите его.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

export function verifyEmailLetter(name: string, url: string): AuthLetter {
  const lead = `${name ? `${name}, ` : ''}подтвердите, что это ваш адрес: так мы сможем присылать вам ссылку на смену пароля и важные уведомления.`;
  const note = 'Ссылка действует 48 часов и срабатывает один раз.';
  return {
    subject: 'Подтвердите почту для QEVO',
    text: ['Подтвердите почту для QEVO', '', lead, '', url, '', note].join('\n'),
    html: shell({ preheader: 'Одно нажатие — и почта подтверждена', title: 'Подтвердите почту', lead, button: 'Подтвердить почту', url, note }),
  };
}

export function resetPasswordLetter(name: string, url: string): AuthLetter {
  const lead = `${name ? `${name}, ` : ''}кто-то (надеемся, вы) попросил сменить пароль от QEVO. Нажмите кнопку и придумайте новый.`;
  const note = 'Ссылка действует 1 час и срабатывает один раз. После смены пароля все ваши сеансы на других устройствах завершатся. Если вы не просили — ничего не делайте, пароль останется прежним.';
  return {
    subject: 'Смена пароля QEVO',
    text: ['Смена пароля QEVO', '', lead, '', url, '', note].join('\n'),
    html: shell({ preheader: 'Ссылка на смену пароля', title: 'Смена пароля', lead, button: 'Задать новый пароль', url, note }),
  };
}
