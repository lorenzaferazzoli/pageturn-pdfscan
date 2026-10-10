# Pagine curve sintetiche per misurare Distendi: una pagina di testo piatta piegata come un foglio
# di libro (superficie sviluppabile, piega lungo la rilegatura) e fotografata in prospettiva.
# Le righe di partenza sono perfettamente dritte, quindi ogni curva che resta è un errore.
#   python3 tests/make-curved.py      (servono numpy, opencv-python, pillow)
import numpy as np, cv2, json, os, math
OUT = 'tests/fixtures/curve'; os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(7)


def rotm(ax, ay, az):
    cx, sx, cy, sy, cz, sz = math.cos(ax), math.sin(ax), math.cos(ay), math.sin(ay), math.cos(az), math.sin(az)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def make(name, page, spine='left', theta0=0.9, lam=0.18, tilt=(0.25, 0.1, 0.03), dist=2.6, W=1200, H=1600, wave=0.0):
    ph, pw = page.shape[:2]
    asp = ph / pw
    # curva della pagina in funzione dell'ascissa curvilinea s in [0,1] (unità: larghezza pagina)
    n = 2000
    s = np.linspace(0, 1, n)
    th = theta0 * np.exp(-s / lam) + wave * np.sin(s * 9)
    ds = 1 / (n - 1)
    X = np.concatenate([[0], np.cumsum(np.cos(th[:-1]) * ds)])
    Z = np.concatenate([[0], np.cumsum(np.sin(th[:-1]) * ds)])
    # campionamento della pagina a 2x
    sp = 2
    us = np.linspace(0, 1, pw * sp); vs = np.linspace(0, asp, ph * sp)
    if spine == 'right':
        xi = -np.interp(1 - us, s, X); zi = np.interp(1 - us, s, Z)
    else:
        xi = np.interp(us, s, X); zi = np.interp(us, s, Z)
    P = np.zeros((ph * sp, pw * sp, 3))
    P[:, :, 0] = xi[None, :] - (xi.max() + xi.min()) / 2
    P[:, :, 1] = vs[:, None] - asp / 2
    P[:, :, 2] = -zi[None, :]
    Rm = rotm(*tilt)
    Pc = P @ Rm.T
    Pc[:, :, 2] += dist
    f = 1.15 * max(W, H) / 1.0
    u = f * Pc[:, :, 0] / Pc[:, :, 2] + W / 2
    v = f * Pc[:, :, 1] / Pc[:, :, 2] + H / 2
    # scala per riempire ~80% dell'immagine
    k = min(0.86 * W / (u.max() - u.min()), 0.9 * H / (v.max() - v.min()))
    u = (u - (u.max() + u.min()) / 2) * k + W / 2
    v = (v - (v.max() + v.min()) / 2) * k + H / 2
    # ombra verso la rilegatura
    shade = 0.62 + 0.38 * (1 - np.exp(-us / 0.08)) if spine == 'left' else 0.62 + 0.38 * (1 - np.exp(-(1 - us) / 0.08))
    tex = cv2.resize(page, (pw * sp, ph * sp), interpolation=cv2.INTER_LINEAR).astype(np.float32) * shade[None, :, None]
    acc = np.zeros((H, W, 3)); cnt = np.zeros((H, W))
    ui = np.round(u).astype(int).ravel(); vi = np.round(v).astype(int).ravel()
    ok = (ui >= 0) & (ui < W) & (vi >= 0) & (vi < H)
    np.add.at(acc, (vi[ok], ui[ok]), tex.reshape(-1, 3)[ok])
    np.add.at(cnt, (vi[ok], ui[ok]), 1)
    bg = (rng.normal(0, 6, (H, W, 3)) + np.array([52, 44, 38])).astype(np.float32)
    bg = cv2.GaussianBlur(bg, (0, 0), 1.5)
    img = bg.copy()
    m = cnt > 0
    img[m] = acc[m] / cnt[m][:, None]
    # buchi
    hole = (~m) & (cv2.dilate(m.astype(np.uint8), np.ones((3, 3))) > 0) & (cv2.erode(m.astype(np.uint8), np.ones((3, 3))) == 0)
    img2 = cv2.medianBlur(np.clip(img, 0, 255).astype(np.uint8), 3)
    fill = (~m) & (cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5))) > 0)
    img = np.clip(img, 0, 255).astype(np.uint8); img[fill] = img2[fill]
    img = cv2.GaussianBlur(img, (0, 0), 0.7)
    img = np.clip(img.astype(np.float32) + rng.normal(0, 3, img.shape), 0, 255).astype(np.uint8)
    corners = [(u[0, 0], v[0, 0]), (u[0, -1], v[0, -1]), (u[-1, -1], v[-1, -1]), (u[-1, 0], v[-1, 0])]
    cv2.imwrite(f'{OUT}/{name}.jpg', img[:, :, ::-1], [cv2.IMWRITE_JPEG_QUALITY, 80])
    return [(x / W, y / H) for x, y in corners]



def text_page(fsz, lh, seed):
    from PIL import Image, ImageDraw, ImageFont
    import random
    random.seed(seed)
    words = ("la conoscenza organizzativa nasce dall interazione tra individui gruppi e ambiente il processo di apprendimento "
             "richiede tempo pratica e condivisione delle esperienze secondo diversi autori le organizzazioni che apprendono "
             "sono capaci di trasformare informazioni in competenze durature attraverso il dialogo e la riflessione").split()
    W, H = 1240, 1754
    im = Image.new('RGB', (W, H), (246, 244, 238))
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', fsz)
    y = 110
    while y < H - 130:
        line = []
        while True:
            w = random.choice(words)
            if d.textlength(' '.join(line + [w]), font=f) > W - 220:
                break
            line.append(w)
        d.text((110, y), ' '.join(line), font=f, fill=(25, 25, 25))
        y += lh
    return np.asarray(im)

pages = {n: text_page(*a) for n, a in {'testo-a': (30, 44, 3), 'testo-b': (26, 38, 4)}.items()}
cfg = [
    ('sx-media', 'testo-a', dict(spine='left', theta0=0.9, lam=0.15, tilt=(0.2, 0.15, 0.02))),
    ('sx-stretta', 'testo-b', dict(spine='left', theta0=1.1, lam=0.12, tilt=(0.3, -0.1, -0.03))),
    ('dx-media', 'testo-a', dict(spine='right', theta0=0.8, lam=0.2, tilt=(0.15, 0.2, 0.04))),
    ('dx-stretta', 'testo-b', dict(spine='right', theta0=1.2, lam=0.1, tilt=(0.35, 0.05, 0.0))),
    ('sx-forte', 'testo-a', dict(spine='left', theta0=1.3, lam=0.22, tilt=(0.25, 0.0, 0.05))),
    ('sx-lieve', 'testo-b', dict(spine='left', theta0=0.5, lam=0.25, tilt=(0.1, 0.1, -0.02))),
]
gt = {}
for name, p, kw in cfg:
    gt[name] = {'page': p, 'quad': make(name, pages[p], **kw)}
json.dump({k: v['quad'] for k, v in gt.items()}, open(OUT + '/quads.json', 'w'), indent=1)
print('ok:', ', '.join(gt))
