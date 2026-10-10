# Sfoglia

Scanner di libri in PDF che gira nel browser del telefono. Niente app store, niente account, niente cloud di terzi: è una web app che si installa sulla schermata Home, funziona offline ed è open source.

**Provala:** https://lorenzaferazzoli.github.io/sfoglia/

![Schermate di Sfoglia](docs/schermate.png)

## Cosa fa

- **Scatto automatico.** Riconosce la pagina nell'inquadratura e scatta da sola quando è ferma e nitida. Poi aspetta che giri pagina: vede la mano, poi la pagina nuova, e scatta di nuovo. C'è anche lo scatto manuale e, per le pagine difficili, la fotocamera nativa di iOS a piena risoluzione.
- **Niente scansioni perse.** Ogni foto viene scritta nell'archivio del browser appena scattata, prima di qualsiasi elaborazione. Se l'app si chiude o il telefono si spegne, riapri e trovi tutto.
- **Backup automatico sul tuo server** (facoltativo). Ogni foto parte verso il tuo server appena salvata; se la rete manca, riprova da sola. In più puoi esportare il progetto in un file .zip e reimportarlo.
- **Pagina raddrizzata** con la correzione della prospettiva, angoli regolabili a mano.
- **Sbiancamento:** carta bianca, ombra della piega e ingiallimento rimossi. Filtri Originale, Sbianca, Grigi, B/N, con luminosità e contrasto.
- **Doppia pagina:** uno scatto del libro aperto diventa due pagine. Si può anche dividere una pagina dopo.
- **Gomma** per macchie, segni a matita e dita sul bordo.
- **Avviso sulle foto mosse**, rotazione, riordino trascinando, riscatto di una singola pagina.
- **OCR italiano e inglese** sul telefono (Tesseract): il PDF ha il testo ricercabile e selezionabile.
- **Esportazione** in PDF (tre livelli di qualità) o in immagini JPEG, con salvataggio diretto su File, iCloud Drive, Google Drive o Dropbox dal menu Condividi.
- **Leggera e veloce.** L'elaborazione gira in background: nelle prove 120 pagine vengono elaborate senza bloccare l'interfaccia.
- **Tema chiaro e scuro**, automatico o scelto a mano.

## Installarla su iPhone

1. Apri https://lorenzaferazzoli.github.io/sfoglia/ in **Safari**.
2. Tocca **Condividi**, poi **Aggiungi alla schermata Home**.
3. Apri Sfoglia dall'icona e consenti l'accesso alla fotocamera.

Installarla è importante: Safari può cancellare i dati dei siti che non visiti da 7 giorni, ma le app aggiunte alla schermata Home ne sono esenti.

Su Android funziona allo stesso modo con Chrome (menu ⋮ → *Installa app*).

## Ospitarla da te (self-hosting)

Il server incluso serve l'app e riceve il backup automatico delle pagine. Non ha dipendenze.

**Con Node 18 o superiore**

```sh
git clone https://github.com/lorenzaferazzoli/sfoglia.git
cd sfoglia
SFOGLIA_TOKEN=un-codice-segreto node server/server.js
```

**Con Docker**

```sh
docker compose up -d   # modifica prima SFOGLIA_TOKEN in docker-compose.yml
```

I backup finiscono in `./data/<libro>/pages/` come JPEG originali più un file .json per pagina.

Nell'app, apri **Impostazioni → Backup automatico sul server**, inserisci l'indirizzo e il codice, poi tocca *Verifica connessione*. Se apri l'app direttamente dal tuo server senza codice di accesso, il backup si attiva da solo.

**Serve https.** I browser danno accesso alla fotocamera solo su https (o su `localhost`). Le strade più semplici:

- [Tailscale](https://tailscale.com/kb/1312/serve): `tailscale serve 8080` dà un indirizzo https privato raggiungibile dai tuoi dispositivi;
- un reverse proxy con certificato automatico, per esempio [Caddy](https://caddyserver.com/): `reverse_proxy localhost:8080`;
- certificato tuo: `TLS_CERT=cert.pem TLS_KEY=key.pem node server/server.js`.

Puoi anche usare l'app da GitHub Pages e il server solo per il backup: il server accetta richieste da altre origini (variabile `CORS_ORIGIN` per limitarle).

| Variabile | Predefinito | Significato |
|---|---|---|
| `PORT` | `8080` | porta |
| `DATA_DIR` | `./data` | cartella dei backup |
| `SFOGLIA_TOKEN` | nessuno | codice di accesso richiesto all'app |
| `TLS_CERT`, `TLS_KEY` | nessuno | https diretto |
| `CORS_ORIGIN` | `*` | origine ammessa per l'app ospitata altrove |

## Privacy

Le foto restano sul telefono e, se lo configuri, sul tuo server. L'OCR avviene sul dispositivo. L'app non contatta altri servizi: tutte le librerie sono incluse nel repository.

## Limiti noti

- La curvatura delle pagine vicino alla rilegatura non viene distesa: lo sbiancamento toglie l'ombra, ma le righe molto curve restano curve. Fotografare dall'alto con il libro ben aperto aiuta.
- Il riconoscimento della pagina cerca la carta chiara su uno sfondo più scuro. Su un tavolo bianco conviene lo scatto manuale e la regolazione degli angoli.
- Con la fotocamera dentro l'app la risoluzione è quella del video (fino a 4K, dipende dal telefono). Per le pagine con caratteri minuti c'è la fotocamera di iOS a piena risoluzione.
- L'OCR sul telefono richiede qualche secondo a pagina; per un libro intero conviene lasciare l'app aperta in carica.

## Sviluppo

Nessun passaggio di build: sono file statici e moduli JavaScript.

```sh
npm install
npm start                    # http://localhost:8080
npm test                     # prova completa in Chromium con una finta fotocamera
node tests/stress.mjs 120    # prova di carico
npm run vendor               # dopo aver aggiornato le librerie
```

| Cartella | Contenuto |
|---|---|
| `js/` | app (`app.js`), archivio (`db.js`), fotocamera e scatto automatico (`camera.js`, `detect.js`), elaborazione immagini (`proc.js`, `render.js`, nel worker), coda (`queue.js`), OCR, PDF e backup (`ocr.js`, `export.js`), backup sul server (`sync.js`) |
| `server/` | server Node senza dipendenze |
| `vendor/` | librerie incluse (vedi [THIRD-PARTY.md](THIRD-PARTY.md)) |
| `tests/` | prove automatiche e immagini di prova |

## Licenza

[MIT](LICENSE).
