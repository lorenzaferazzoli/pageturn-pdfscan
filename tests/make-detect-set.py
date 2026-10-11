# Foto sintetiche per misurare il riconoscimento dei bordi: pagina con angoli noti, sfondi diversi,
# libro aperto con la pagina accanto, luce non uniforme.
#   python3 tests/make-detect-set.py      (servono numpy, opencv-python, pillow)
import numpy as np, cv2, json, os, math, random
from PIL import Image, ImageDraw, ImageFont
OUT = 'tests/fixtures/detect'
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(11)
random.seed(5)
WORDS = ("la conoscenza organizzativa nasce dall interazione tra individui gruppi e ambiente il processo di apprendimento "
         "richiede tempo pratica e condivisione delle esperienze secondo diversi autori le organizzazioni che apprendono").split()
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'


def text_page(W=1240, H=1754, fsz=26, lh=38, margin=110, tint=(246, 244, 238)):
    im = Image.new('RGB', (W, H), tint)
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT, fsz)
    y = margin
    while y < H - margin:
        line = []
        while True:
            w = random.choice(WORDS)
            if d.textlength(' '.join(line + [w]), font=f) > W - 2 * margin:
                break
            line.append(w)
        d.text((margin, y), ' '.join(line), font=f, fill=(25, 25, 25))
        y += lh
    return np.asarray(im).astype(np.float32)


def background(kind, W, H):
    if kind == 'scuro':
        bg = np.zeros((H, W, 3), np.float32) + np.array([50, 42, 36]) + rng.normal(0, 6, (H, W, 3))
    elif kind == 'legno':
        x = np.linspace(0, 1, W)[None, :]
        y = np.linspace(0, 1, H)[:, None]
        v = 110 + 30 * np.sin(x * 40 + 3 * np.sin(y * 7)) + rng.normal(0, 8, (H, W))
        bg = np.stack([v * 1.0, v * 0.72, v * 0.5], -1)
    elif kind == 'chiaro':
        bg = np.zeros((H, W, 3), np.float32) + np.array([206, 204, 198]) + rng.normal(0, 5, (H, W, 3))
    elif kind == 'disordinato':
        bg = np.zeros((H, W, 3), np.float32) + np.array([120, 115, 108]) + rng.normal(0, 6, (H, W, 3))
        for _ in range(14):
            x0, y0 = rng.integers(0, W), rng.integers(0, H)
            cv2.rectangle(bg, (int(x0), int(y0)), (int(x0 + rng.integers(60, 400)), int(y0 + rng.integers(40, 300))), [float(c) for c in rng.integers(30, 240, 3)], -1)
    else:  # tessuto grigio
        bg = np.zeros((H, W, 3), np.float32) + np.array([80, 82, 86]) + rng.normal(0, 14, (H, W, 3))
        bg = cv2.GaussianBlur(bg, (0, 0), 1.2)
    return bg.astype(np.float32)


def homog(src, dst):
    return cv2.getPerspectiveTransform(np.float32(src), np.float32(dst))


def make(name, bg_kind, open_book=None, light=0.0, W=1050, H=1400, jitter=0.08, scale=0.78):
    page = text_page(tint=tuple(int(c) for c in rng.integers(232, 250, 3)))
    ph, pw = page.shape[:2]
    # angoli di destinazione: rettangolo centrato con prospettiva casuale
    cx, cy = W / 2, H / 2
    hh = H * scale / 2
    page = cv2.resize(page, (pw * 7 // 10, ph * 7 // 10), interpolation=cv2.INTER_AREA)
    ph, pw = page.shape[:2]
    hw = hh * pw / ph
    if open_book:
        cx += hw * (0.45 if open_book == 'sx' else -0.45)  # la pagina accanto entra nell'inquadratura
    base = [(cx - hw, cy - hh), (cx + hw, cy - hh), (cx + hw, cy + hh), (cx - hw, cy + hh)]
    dst = [(x + rng.normal(0, jitter * hw), y + rng.normal(0, jitter * hh)) for x, y in base]
    img = background(bg_kind, W, H)
    M = homog([(0, 0), (pw, 0), (pw, ph), (0, ph)], dst)
    if open_book:
        # pagina accanto: stessa altezza, attaccata sul lato della rilegatura, più ombra verso la piega
        other = cv2.resize(text_page(tint=tuple(int(c) for c in rng.integers(228, 246, 3))), (pw, ph), interpolation=cv2.INTER_AREA)
        xs = np.linspace(0, 1, pw)[None, :, None]
        if open_book == 'sx':  # rilegatura a sinistra della pagina: l'altra pagina è a sinistra
            other = other * (0.6 + 0.4 * np.clip((1 - xs) / 0.25, 0, 1) ** 0.6)
            sh = [(-pw, 0), (0, 0), (0, ph), (-pw, ph)]
        else:
            other = other * (0.6 + 0.4 * np.clip(xs / 0.25, 0, 1) ** 0.6)
            sh = [(pw, 0), (2 * pw, 0), (2 * pw, ph), (pw, ph)]
        # la stessa omografia della pagina, estesa
        Mo = M @ homog([(0, 0), (pw, 0), (pw, ph), (0, ph)], sh)
        ow = cv2.warpPerspective(other, Mo, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(-1, -1, -1))
        m = ow[:, :, 0] >= 0
        img[m] = ow[m]
        # ombra della piega sulla pagina vera
        xs = np.linspace(0, 1, pw)[None, :, None]
        page = page * ((0.62 + 0.38 * np.clip(xs / 0.2, 0, 1) ** 0.6) if open_book == 'sx' else (0.62 + 0.38 * np.clip((1 - xs) / 0.2, 0, 1) ** 0.6))
    pw_ = cv2.warpPerspective(page, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(-1, -1, -1))
    m = pw_[:, :, 0] >= 0
    img[m] = pw_[m]
    if light:
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        img *= (1 - light * (xx / W * 0.6 + yy / H * 0.4))[..., None]
    img = cv2.GaussianBlur(img, (0, 0), 1.0) + rng.normal(0, 3, img.shape)
    cv2.imwrite(f'{OUT}/{name}.jpg', np.clip(img, 0, 255).astype(np.uint8)[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 80])
    return [(x / W, y / H) for x, y in dst]


gt = {}
cases = []
for i, bg in enumerate(['scuro', 'legno', 'chiaro', 'disordinato', 'tessuto']):
    for j, ob in enumerate([None, 'sx', 'dx']):
        cases.append((bg, ob, 0.35 if (i + j) % 2 else 0.0))
for i, (bg, ob, li) in enumerate(cases):
    n = f'{i:02d}-{bg}-{ob or "sola"}-{"luce" if li else "pari"}'
    gt[n] = make(n, bg, ob, li)
json.dump(gt, open(OUT + '/quads.json', 'w'), indent=1)
print(len(gt), 'immagini')
