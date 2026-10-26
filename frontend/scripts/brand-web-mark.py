"""
Фавиконы и знак CRM из картинки-ЗНАКА без надписи (#4671, 26.10.2026: знак QEVO с
шестерёнкой — «на поддомене» app.qevo.one). brand-assets.py рассчитан на исходник
«знак + надпись» и пересобирает ещё и иконки Android — здесь только веб.

Запуск: python frontend/scripts/brand-web-mark.py <путь к знаку.png>

public/: logo-mark.png (512, прозрачный) · favicon-32/64.png · apple-touch-icon.png
(180, белая подложка — iOS заливает прозрачность чёрным) · icon-192/512.png (PWA, белая
подложка). Знак обрезается по непрозрачным пикселям; поля — как в brand-assets.py.
Новые файлы на старых адресах: в index.html и Logo.tsx стоит ?v=N — поднимите его,
иначе браузеры покажут старый значок из кэша.
"""
import os, sys
from PIL import Image

SRC = sys.argv[1]
PUB = os.path.join(os.path.dirname(__file__), '..', 'public')

src = Image.open(SRC).convert('RGBA')
MARK = src.crop(src.split()[3].point(lambda v: 255 if v > 20 else 0).getbbox())


def fit(img, size, scale, bg=None):
    canvas = Image.new('RGBA', (size, size), bg or (0, 0, 0, 0))
    side = int(size * scale)
    k = side / max(img.size)
    piece = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)
    canvas.alpha_composite(piece, ((size - piece.width) // 2, (size - piece.height) // 2))
    return canvas


def save(img, name, rgb_bg=None):
    path = os.path.join(PUB, name)
    if rgb_bg is not None:
        flat = Image.new('RGB', img.size, rgb_bg)
        flat.paste(img, mask=img.split()[3])
        flat.save(path, optimize=True)
    else:
        img.save(path, optimize=True)
    print('ok', name, img.size)


WHITE = (255, 255, 255)
save(fit(MARK, 512, 0.92), 'logo-mark.png')
# на вкладке знак крупнее: мелкий ряд пикселей съедает поля
save(fit(MARK, 32, 1.0), 'favicon-32.png')
save(fit(MARK, 64, 0.98), 'favicon-64.png')
save(fit(MARK, 180, 0.8), 'apple-touch-icon.png', WHITE)
save(fit(MARK, 192, 0.8), 'icon-192.png', WHITE)
save(fit(MARK, 512, 0.8), 'icon-512.png', WHITE)
