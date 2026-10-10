# Pageturn

*[Italiano](README.md) · English*

A book scanner that turns pages into PDFs, running in your phone's browser. No app store, no account, no third-party cloud: it's a web app you add to your Home Screen. It works offline and it's open source.

**Try it:** https://lorenzaferazzoli.github.io/pageturn-pdfscan/

The app interface is in Italian.

![Pageturn screenshots](docs/schermate.png)

## What it does

- **Automatic capture.** It finds the page in the viewfinder and takes the shot by itself once the page is still and in focus. Then it waits for you to turn the page: it sees your hand, then the new page, and shoots again. There's also a manual shutter and, for tricky pages, the native iOS camera at full resolution.
- **Stabilization.** For every shot it looks at a few consecutive frames and keeps the sharpest one, measuring blur on the page text itself. With the manual shutter it waits a moment for the phone to settle after the tap.
- **No lost scans.** Every photo is written to the browser's storage the moment it's taken, before any processing. If the app closes or the phone dies, reopen it and everything is there.
- **Automatic backup to your own server** (optional). Each photo is sent to your server as soon as it's saved; if the network is down, it retries on its own. You can also export a project as a .zip file and import it back.
- **Straightened pages** with perspective correction and manually adjustable corners.
- **Whitening:** white paper, with the gutter shadow and yellowing removed. Ink is brought to full black page by page, and sharpening works at two scales and is adjustable. Filters: Original, Whiten, Grayscale and B/W, each with brightness, contrast and sharpness.
- **Open books:** finds the fold between the two pages. In single-page mode it keeps the whole page and discards the sliver of the facing one; in *Double page* mode every shot becomes two pages, split along the fold.
- **Accurate corners:** two methods combined, the brightest paper region and the straight page edges (Hough transform). The quadrilateral with the most real edges under its sides wins. It works on light, cluttered backgrounds too, and a finger over a corner doesn't move it.
- **Precise cropping:** drag the corners or whole sides, with a magnifying loupe.
- **Free view:** full screen with pinch zoom and panning, on the full-resolution page or the original photo, to check whether a shot is blurry.
- **Split** with a line that starts on the detected fold and can be moved and tilted.
- **Undo and redo** for every edit to a page, splitting included.
- **Edits to all pages** (*More* menu, can be switched on and off): filter, brightness, contrast, sharpness and *Unwarp* apply to the whole book.
- **A4 PDF** with 1 cm margins, or pages sized like the photo.
- **Eraser** for stains, pencil marks and fingers on the edge. The stroke appears under your finger right away and the real result follows a moment later, with a loupe showing what you're erasing.
- **Blurry photo warning**, rotation, drag-to-reorder, and re-shooting a single page.
- **Curved pages:** the *Unwarp* tool straightens lines bent near the binding (UVDoc model), on one page or on all selected pages.
- **On-device OCR** with two engines: *Accurate* (PaddleOCR PP-OCRv5; Italian, English and other Latin-script languages) and *Fast* (Tesseract). The PDF gets a searchable, selectable text layer.
- **Export** to PDF (three quality levels) or JPEG images. From the Share menu you can save straight to Files, iCloud Drive, Google Drive or Dropbox.
- **Light and fast.** Processing runs in the background: in tests, 120 pages are processed without ever blocking the interface.
- **Light and dark theme**, automatic or chosen by hand.

## Installing on iPhone

1. Open https://lorenzaferazzoli.github.io/pageturn-pdfscan/ in Safari, Opera, Chrome, Edge or Firefox.
2. Tap **Share**, then **Add to Home Screen**.
3. Open Pageturn from its icon and allow camera access.

Installing matters. Safari may delete data from sites you haven't visited in 7 days, but apps added to the Home Screen are exempt. Since iOS 16.4 you can add the app from any browser. Once installed, it opens from its icon and runs on its own, separate from the browser you added it from.

Note: the installed app and the same page opened in a browser have **separate storage**. If you already scanned inside the browser, export the backup (.zip) there and import it into the installed app (*Impostazioni → Importa un backup*).

Under *Impostazioni → Informazioni → Ambiente* the app shows where it's running: browser, engine, offline support and multithreaded OCR.

On Android it works the same way with Chrome (menu ⋮ → *Install app*).

## Self-hosting

The bundled server serves the app and receives the automatic page backups. It has no dependencies.

**With Node 18 or later**

```sh
git clone https://github.com/lorenzaferazzoli/pageturn-pdfscan.git
cd pageturn-pdfscan
PAGETURN_TOKEN=a-secret-code node server/server.js
```

**With Docker**

```sh
docker compose up -d   # set PAGETURN_TOKEN in docker-compose.yml first
```

Backups are stored in `./data/<book>/pages/` as original JPEGs plus one .json file per page.

In the app, open **Impostazioni → Backup automatico sul server**, enter the address and the code, then tap *Verifica connessione*. If you open the app straight from your server and no access code is set, backup turns on by itself.

**HTTPS is required.** Browsers only allow camera access over HTTPS (or on `localhost`). The simplest options:

- [Tailscale](https://tailscale.com/kb/1312/serve): `tailscale serve 8080` gives you a private HTTPS address reachable from your devices;
- a reverse proxy with automatic certificates, for example [Caddy](https://caddyserver.com/): `reverse_proxy localhost:8080`;
- your own certificate: `TLS_CERT=cert.pem TLS_KEY=key.pem node server/server.js`.

You can also use the app from GitHub Pages and the server for backups only. The server accepts requests from other origins; set `CORS_ORIGIN` to restrict them.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | port |
| `DATA_DIR` | `./data` | backup folder |
| `PAGETURN_TOKEN` | none | access code the app must provide |
| `TLS_CERT`, `TLS_KEY` | none | serve HTTPS directly |
| `CORS_ORIGIN` | `*` | allowed origin when the app is hosted elsewhere |

## Privacy

Photos stay on your phone and, if you set it up, on your server. OCR runs on the device. The app contacts no other service: every library is bundled in the repository.

## Known limitations

- *Unwarp* works on the photo around the page and leaves already-flat pages untouched. With very strong folds it can distort the page edges. You see it right away in the preview, and you can switch it off or undo it.
- Page detection works best with the paper on a darker background. On light backgrounds it relies on the page edges, but if the facing page is as light as the one you're scanning, it's better to adjust the corners by hand (with the loupe).
- With the in-app camera, resolution is that of the video stream (up to 4K, depending on the phone). For pages with very small print, use the native iOS camera at full resolution.
- On-device OCR takes a few seconds per page, and the *Accurate* engine takes about three times as long as *Fast*. For a whole book, keep the app open while charging. The models are downloaded the first time: about 27 MB for *Accurate*, 10 MB for *Fast* and 31 MB for *Unwarp*.

## Which OCR engine

Comparison on the test pages in `tests/fixtures/ocr` (character error rate, lower is better; `node tests/ocr-compare.mjs`):

| Page | Tesseract | PaddleOCR |
|---|---|---|
| novel, sharp photo | 0.0% | 0.0% |
| textbook with footnote | 0.7% | 0.7% |
| low-resolution photo (700 px) | 12.1% | 1.5% |
| page curved near the binding | 16.1% | 0.0% |
| textbook, curved page | 19.9% | 13.9% |

On clean pages the two engines are equivalent; on small photos and curved pages PaddleOCR makes far fewer mistakes.

## Development

No build step: just static files and JavaScript modules.

```sh
npm install
npm start                    # http://localhost:8080
npm test                     # full run in Chromium with a fake camera
node tests/stress.mjs 120    # load test
node tests/stabilizer.mjs    # stabilization: every shot must come out sharp
node tests/detect-check.mjs  # draws page detection results into tests/out/
npm run vendor               # after updating the libraries
sh scripts/paddle-models.sh  # to download the PaddleOCR models again
```

| Folder | Contents |
|---|---|
| `js/` | app (`app.js`), storage (`db.js`), camera, automatic capture and stabilization (`camera.js`, `detect.js`), image processing (`proc.js`, `render.js`, in a worker), queue (`queue.js`), OCR (`ocr.js`, `paddle.js`, `paddle-worker.js`), PDF and backup (`export.js`), server backup (`sync.js`) |
| `server/` | dependency-free Node server |
| `vendor/` | bundled libraries (see [THIRD-PARTY.md](THIRD-PARTY.md)) |
| `tests/` | automated tests and test images |

## License

[GPL-3.0](LICENSE): you can use, modify and redistribute it, as long as modified versions stay open source under the same license.
