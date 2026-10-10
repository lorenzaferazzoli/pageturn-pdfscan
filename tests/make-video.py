# Video per la finta fotocamera: pagina, mano che gira pagina, pagina nuova, mano.
import subprocess
from PIL import Image, ImageOps, ImageDraw
d = 'tests/fixtures/'
a = Image.open(d + 'frame.png').convert('RGB')
b = ImageOps.mirror(a)
hand = a.copy(); ImageDraw.Draw(hand).rectangle([0, 200, 520, 900], fill=(150, 110, 90))
a.save(d + 'fa.png'); b.save(d + 'fb.png'); hand.save(d + 'fh.png')
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error',
  '-loop', '1', '-t', '2.5', '-i', d + 'fa.png', '-loop', '1', '-t', '0.8', '-i', d + 'fh.png',
  '-loop', '1', '-t', '2.5', '-i', d + 'fb.png', '-loop', '1', '-t', '0.8', '-i', d + 'fh.png',
  '-filter_complex', '[0][1][2][3]concat=n=4:v=1:a=0,fps=15,format=yuv420p', d + 'cam.y4m'], check=True)
print('ok')
