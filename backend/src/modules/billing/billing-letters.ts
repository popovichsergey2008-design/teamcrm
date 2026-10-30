/** Письма об оплате владельцу компании. Простая вёрстка — как у писем входа (auth-letters). */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const day = (d: Date | null) => (d ? d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '');

const TEXTS: Record<string, (until: Date | null) => { subject: string; lead: string; button: string }> = {
  trial_3d: (u) => ({ subject: 'Пробный период QEVO заканчивается', lead: `Пробный период закончится ${day(u)}. Чтобы команда работала без перерыва, выберите тариф и оплатите — это пара минут.`, button: 'Выбрать тариф' }),
  trial_1d: (u) => ({ subject: 'Завтра заканчивается пробный период QEVO', lead: `Пробный период закончится ${day(u)}. После этого будет 3 дня на оплату, потом QEVO перейдёт в режим «только чтение». Данные никуда не денутся.`, button: 'Оплатить' }),
  renew_3d: (u) => ({ subject: 'Скоро продление QEVO', lead: `Оплаченный период закончится ${day(u)}. Продлите подписку, чтобы работа не прерывалась.`, button: 'Продлить' }),
  grace: (u) => ({ subject: 'QEVO не оплачен — 3 дня на оплату', lead: `Подписка не оплачена. До ${day(u)} всё работает как обычно, потом QEVO перейдёт в режим «только чтение»: смотреть можно, менять — нет. Данные сохранятся.`, button: 'Оплатить' }),
  read_only: () => ({ subject: 'QEVO в режиме «только чтение»', lead: 'Подписка не оплачена, поэтому QEVO перешёл в режим «только чтение»: всё видно, но менять ничего нельзя. Данные сохранены — после оплаты всё заработает сразу.', button: 'Оплатить и продолжить' }),
  paid: (u) => ({ subject: 'Оплата QEVO прошла', lead: `Спасибо! Оплата получена, подписка действует до ${day(u)}.`, button: 'Открыть QEVO' }),
  autopay_failed: () => ({ subject: 'Не удалось продлить QEVO', lead: 'Автоматическое продление не прошло: банк отклонил списание. Оплатите вручную, чтобы работа не прервалась.', button: 'Оплатить' }),
};

export function billingLetter(kind: string, until: Date | null, url: string): { subject: string; text: string; html: string } | null {
  const t = TEXTS[kind]?.(until);
  if (!t) return null;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>QEVO</title></head>
<body style="margin:0;padding:0;background:#f5f1ea;">
<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%;background:#f5f1ea"><tr><td align="center" style="padding:28px 12px">
<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%;max-width:520px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif">
<tr><td style="padding:0 4px 14px"><span style="font-size:20px;font-weight:800;color:#193b91">QEVO</span></td></tr>
<tr><td style="background:#fffefb;border:1px solid #e3dcd0;border-radius:12px;padding:24px 26px">
<p style="margin:0 0 12px;font-size:19px;font-weight:700;color:#211d18">${esc(t.subject)}</p>
<p style="margin:0 0 20px;font-size:14px;line-height:1.55;color:#544c41">${esc(t.lead)}</p>
<table cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td style="background:#0a6bb0;border-radius:8px">
<a href="${esc(url)}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">${esc(t.button)}</a>
</td></tr></table></td></tr></table></td></tr></table></body></html>`;
  return { subject: t.subject, text: [t.subject, '', t.lead, '', url].join('\n'), html };
}
