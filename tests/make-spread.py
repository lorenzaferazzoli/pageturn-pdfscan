# Libro aperto su due pagine intere, con l'ombra della rilegatura, fotografato storto.
import numpy as np
from PIL import Image, ImageOps
d = 'tests/fixtures/'
p = np.asarray(Image.open(d + 'page-flat.png').convert('RGB')).astype(np.float32)
q = np.asarray(Image.open(d + 'ocr/romanzo.png').convert('RGB').resize((1240, 1754))).astype(np.float32)
h, w, _ = p.shape
x = np.linspace(0, 1, w)[None, :, None]
left = p * (0.62 + 0.38 * np.clip((1 - x) / 0.18, 0, 1) ** 0.5)   # ombra verso la piega (a destra)
right = q * (0.62 + 0.38 * np.clip(x / 0.18, 0, 1) ** 0.5)        # ombra verso la piega (a sinistra)
spread = np.concatenate([left, right], axis=1)
H2, W2 = spread.shape[:2]
W, H = 3000, 2400
bg = np.zeros((H, W, 3), np.float32) + np.array([40, 34, 30], np.float32)
bg += np.random.default_rng(3).normal(0, 7, bg.shape)
dst = [(420, 520), (2620, 440), (2700, 1990), (330, 2080)]
src = [(0, 0), (W2, 0), (W2, H2), (0, H2)]
A = []; B = []
for (x1, y1), (x2, y2) in zip(dst, src):
    A.append([x1, y1, 1, 0, 0, 0, -x2 * x1, -x2 * y1]); B.append(x2)
    A.append([0, 0, 0, x1, y1, 1, -y2 * x1, -y2 * y1]); B.append(y2)
c = tuple(np.linalg.solve(np.array(A), np.array(B)))
im = Image.fromarray(np.clip(spread, 0, 255).astype(np.uint8)).transform((W, H), Image.PERSPECTIVE, c, Image.BICUBIC)
mask = Image.new('L', (W2, H2), 255).transform((W, H), Image.PERSPECTIVE, c, Image.BICUBIC)
out = Image.fromarray(np.clip(bg, 0, 255).astype(np.uint8)); out.paste(im, (0, 0), mask)
out.resize((1500, 1200), Image.LANCZOS).save('tests/fixtures/real/due-pagine.jpg', quality=88)
print('ok')
