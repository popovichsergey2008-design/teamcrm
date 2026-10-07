"""
Картинки бренда QEVO из одного исходника (private/TZ/QEVO.png — знак + надпись на прозрачном).

Запуск: python frontend/scripts/brand-assets.py <путь к QEVO.png>

Что собирает:
  public/   logo-mark.png (знак, 512, прозрачный) · logo-full.png (знак + надпись) ·
            favicon-32/64.png (ТОЛЬКО знак, без букв — просьба заказчика) ·
            apple-touch-icon.png (180, белая подложка: iOS прозрачность заливает чёрным) ·
            icon-192/512.png (PWA, белая подложка)
  android/  mipmap-*/ic_launcher*.png (обычная, круглая, слои адаптивной иконки) ·
            drawable*/splash.png (знак по центру: светлая и ночная заставки) ·
            drawable-*dpi/ic_stat_notify.png (белый силуэт знака — Android требует одноцветный)

Знак вырезается по непрозрачным пикселям над надписью; поля вокруг — чтобы на вкладке и
на рабочем столе он не упирался в края.
"""
import os, sys
from PIL import Image, ImageDraw

SRC = sys.argv[1]
ROOT = os.path.join(os.path.dirname(__file__), '..')
PUB = os.path.join(ROOT, 'public')
RES = os.path.join(ROOT, 'native', 'android', 'app', 'src', 'main', 'res')

src = Image.open(SRC).convert('RGBA')
alpha = src.split()[3]
mark_box = alpha.crop((0, 0, src.width, 860)).point(lambda v: 255 if v > 20 else 0).getbbox()
full_box = alpha.point(lambda v: 255 if v > 20 else 0).getbbox()
MARK = src.crop(mark_box)
FULL = src.crop(full_box)


def fit(img, size, scale, bg=None):
    """img по центру квадрата size×size, занимая долю scale стороны."""
    canvas = Image.new('RGBA', (size, size), bg or (0, 0, 0, 0))
    side = int(size * scale)
    w, h = img.size
    k = side / max(w, h)
    piece = img.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
    canvas.alpha_composite(piece, ((size - piece.width) // 2, (size - piece.height) // 2))
    return canvas


def save(img, path, rgb_bg=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if rgb_bg is not None:
        flat = Image.new('RGB', img.size, rgb_bg)
        flat.paste(img, mask=img.split()[3])
        flat.save(path, optimize=True)
    else:
        img.save(path, optimize=True)


WHITE = (255, 255, 255)

# ── сайт ──
save(fit(MARK, 512, 0.92), os.path.join(PUB, 'logo-mark.png'))
# полный логотип — по пропорциям исходника, без квадрата
fw = 640; fh = round(FULL.height * fw / FULL.width)
save(FULL.resize((fw, fh), Image.LANCZOS), os.path.join(PUB, 'logo-full.png'))
# фавикон — только знак, почти без полей: на вкладке он 16-32 точки, поле съедает его
save(fit(MARK, 32, 0.96), os.path.join(PUB, 'favicon-32.png'))
save(fit(MARK, 64, 0.96), os.path.join(PUB, 'favicon-64.png'))
save(fit(MARK, 180, 0.74, (255, 255, 255, 255)), os.path.join(PUB, 'apple-touch-icon.png'), WHITE)
save(fit(MARK, 192, 0.74, (255, 255, 255, 255)), os.path.join(PUB, 'icon-192.png'), WHITE)
save(fit(MARK, 512, 0.74, (255, 255, 255, 255)), os.path.join(PUB, 'icon-512.png'), WHITE)

# ── Android: иконки приложения ──
DENS = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
for d, px in DENS.items():
    folder = os.path.join(RES, f'mipmap-{d}')
    # обычная — белый скруглённый квадрат со знаком
    sq = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    ImageDraw.Draw(sq).rounded_rectangle((0, 0, px - 1, px - 1), radius=round(px * 0.22), fill=(255, 255, 255, 255))
    sq.alpha_composite(fit(MARK, px, 0.72))
    save(sq, os.path.join(folder, 'ic_launcher.png'))
    # круглая — белый круг со знаком
    rd = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    ImageDraw.Draw(rd).ellipse((0, 0, px - 1, px - 1), fill=(255, 255, 255, 255))
    rd.alpha_composite(fit(MARK, px, 0.64))
    save(rd, os.path.join(folder, 'ic_launcher_round.png'))
    # слои адаптивной иконки: подложка белая, знак — передний слой (рамку обрезки даёт система)
    save(Image.new('RGBA', (px, px), (255, 255, 255, 255)), os.path.join(folder, 'ic_launcher_background.png'))
    save(fit(MARK, px, 0.86), os.path.join(folder, 'ic_launcher_foreground.png'))

# ── Android: заставка — знак по центру; ночная — на графите тёмной темы ──
for entry in os.listdir(RES):
    if not entry.startswith('drawable'):
        continue
    path = os.path.join(RES, entry, 'splash.png')
    if not os.path.exists(path):
        continue
    w, h = Image.open(path).size
    night = 'night' in entry
    bg = (29, 32, 38, 255) if night else (245, 241, 234, 255)  # --bg тёмной и светлой темы
    canvas = Image.new('RGBA', (w, h), bg)
    side = round(min(w, h) * 0.34)
    piece = fit(MARK, side, 1.0)
    canvas.alpha_composite(piece, ((w - side) // 2, (h - side) // 2))
    save(canvas, path, bg[:3])

# ── Android: значок уведомлений — белый силуэт знака по форме прозрачности ──
SIL = Image.new('RGBA', MARK.size, (255, 255, 255, 0))
SIL.putalpha(MARK.split()[3].point(lambda v: 255 if v > 90 else 0))
for d, px in {'mdpi': 24, 'hdpi': 36, 'xhdpi': 48, 'xxhdpi': 72, 'xxxhdpi': 96}.items():
    save(fit(SIL, px, 0.92), os.path.join(RES, f'drawable-{d}', 'ic_stat_notify.png'))

print('знак', MARK.size, '· логотип', FULL.size, '· готово')
