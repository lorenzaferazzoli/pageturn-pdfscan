# Varianti delle pagine di prova: "hd" (1700 px) e "foto" (950 px, sfocata e rumorosa, come un fotogramma 1080p)
from PIL import Image, ImageFilter
import numpy as np
d = 'tests/fixtures/ocr/'
for n in ['romanzo', 'manuale']:
    im = Image.open(d + n + '.png').convert('RGB')
    for tag, H, blur in [('hd', 1700, 0), ('foto', 950, 0.6)]:
        k = H / im.height
        s = im.resize((int(im.width * k), H), Image.LANCZOS)
        if blur: s = s.filter(ImageFilter.GaussianBlur(blur))
        a = np.asarray(s).astype(np.float32)
        a += np.random.default_rng(2).normal(0, 5 if blur else 1.5, a.shape)
        Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(f'{d}{n}-{tag}.jpg', quality=80)
print('ok')

# Varianti difficili
from PIL import ImageOps
def curl(im):
    # pagina curva vicino alla rilegatura (a sinistra): le righe si piegano e si comprimono
    a = np.asarray(im.convert('RGB')).astype(np.float32); H, W, _ = a.shape
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    t = np.clip(1 - xs / (W * 0.45), 0, 1)
    sy = ys + (ys - H / 2) * 0.10 * t ** 2 + 26 * t ** 2.2
    sx = xs + 60 * t ** 1.8
    xi = np.clip(sx, 0, W - 1).astype(int); yi = np.clip(sy, 0, H - 1).astype(int)
    out = a[yi, xi] * (0.55 + 0.45 * (1 - t ** 1.5))[..., None]  # più scura verso la piega
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
for n in ['romanzo', 'manuale']:
    im = Image.open(d + n + '.png').convert('RGB')
    c = curl(im).resize((int(im.width * 1300 / im.height), 1300), Image.LANCZOS)
    c.save(f'{d}{n}-curva.jpg', quality=82)
    s = im.resize((int(im.width * 700 / im.height), 700), Image.LANCZOS).filter(ImageFilter.GaussianBlur(0.5))
    s.save(f'{d}{n}-piccola.jpg', quality=75)
