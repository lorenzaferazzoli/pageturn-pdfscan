# Compone la "foto" di prova a partire da tests/fixtures/page-flat.png
import numpy as np
from PIL import Image, ImageFilter
page = np.asarray(Image.open('tests/fixtures/page-flat.png').convert('RGB')).astype(np.float32)
h, w, _ = page.shape
x = np.linspace(0, 1, w)[None, :, None]
y = np.linspace(0, 1, h)[None, :, None].transpose(1, 0, 2)
shade = 0.55 + 0.45 * np.clip(x / 0.25, 0, 1) ** 0.6      # ombra della piega a sinistra
shade = shade * (0.88 + 0.12 * (1 - y))                   # luce che cala verso il basso
page = page * shade
W, H = 2000, 2600
bg = np.zeros((H, W, 3), np.float32) + np.array([52, 40, 33], np.float32)
bg += np.random.default_rng(1).normal(0, 6, bg.shape)
# punti di destinazione degli angoli (TL, TR, BR, BL)
dst = [(470, 560), (1560, 480), (1640, 2240), (360, 2120)]
src = [(0, 0), (w, 0), (w, h), (0, h)]
def coeffs(pa, pb):
    A = []; B = []
    for (x1, y1), (x2, y2) in zip(pa, pb):
        A.append([x1, y1, 1, 0, 0, 0, -x2 * x1, -x2 * y1]); B.append(x2)
        A.append([0, 0, 0, x1, y1, 1, -y2 * x1, -y2 * y1]); B.append(y2)
    return np.linalg.solve(np.array(A), np.array(B))
c = coeffs(dst, src)
pim = Image.fromarray(np.clip(page, 0, 255).astype(np.uint8))
warped = pim.transform((W, H), Image.PERSPECTIVE, tuple(c), Image.BICUBIC)
mask = Image.new('L', (w, h), 255).transform((W, H), Image.PERSPECTIVE, tuple(c), Image.BICUBIC).filter(ImageFilter.GaussianBlur(1.2))
out = Image.fromarray(np.clip(bg, 0, 255).astype(np.uint8))
out.paste(warped, (0, 0), mask)
out = out.resize((W // 2, H // 2), Image.LANCZOS)
out.save('tests/fixtures/photo.jpg', quality=88)
out.filter(ImageFilter.GaussianBlur(5)).save('tests/fixtures/photo-blur.jpg', quality=88)
# fotogramma per la finta fotocamera (720x960)
out.resize((720, 936)).save('tests/fixtures/frame.png')
print('ok')
