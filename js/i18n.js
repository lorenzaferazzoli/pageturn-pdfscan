// Lingua dell'interfaccia: italiano, inglese, cinese semplificato.
// La chiave è il testo italiano, così il codice resta leggibile e una traduzione mancante
// mostra l'italiano invece di una chiave vuota. {nome} viene sostituito con i valori passati.
//   tr('Pagina {i} di {n}', { i: 3, n: 40 })
//   trp(3, 'pagina', 'pagine')   →  «3 pagine» / «3 pages» / «3 页»

export const LANGS = [['it', 'Italiano'], ['en', 'English'], ['zh', '中文']];
const LOCALES = { it: 'it-IT', en: 'en-US', zh: 'zh-CN' };
const KEY = 'pageturn-lang';

let pref = 'auto';
let lang = 'it';

// [inglese, cinese]; per i plurali, [[una, molte], [una, molte]] con {n} al posto del numero.
export const T = {
  // tempo e unità
  'mai': ['never', '从未'],
  'ora': ['just now', '刚刚'],
  '{n} min fa': ['{n} min ago', '{n} 分钟前'],
  '1 ora fa': ['1 hour ago', '1 小时前'],
  '{n} ore fa': ['{n} hours ago', '{n} 小时前'],
  'ieri': ['yesterday', '昨天'],
  'pagina|pagine': [['{n} page', '{n} pages'], ['{n} 页', '{n} 页']],
  'selezionata|selezionate': [['{n} selected', '{n} selected'], ['已选 {n} 页', '已选 {n} 页']],
  'pagina eliminata|pagine eliminate': [['{n} page deleted', '{n} pages deleted'], ['已删除 {n} 页', '已删除 {n} 页']],
  'foto importata|foto importate': [['{n} photo imported', '{n} photos imported'], ['已导入 {n} 张照片', '已导入 {n} 张照片']],

  // fogli e messaggi comuni
  'Chiudi': ['Close', '关闭'],
  'Annulla': ['Cancel', '取消'],
  'Ok': ['OK', '好'],
  'Salva': ['Save', '保存'],
  'Elimina': ['Delete', '删除'],
  'Applica': ['Apply', '应用'],
  'Fine': ['Done', '完成'],
  'Fatto': ['Done', '完成'],
  'Riprova': ['Try again', '重试'],
  'Salva in File o Drive': ['Save to Files or Drive', '保存到“文件”或云盘'],
  'Scarica': ['Download', '下载'],
  'Importo {n} foto…': ['Importing photos ({n})…', '正在导入 {n} 张照片…'],
  'Questo formato di immagine non è supportato': ['This image format isn’t supported', '不支持此图片格式'],
  'Importo {i} di {n}…': ['Importing {i} of {n}…', '正在导入 {i} / {n}…'],
  'Spazio esaurito': ['Out of space', '存储空间已满'],
  'Il telefono non ha più spazio per le scansioni. Esporta un backup o un PDF e libera spazio eliminando i libri già esportati.': ['Your phone has no room left for scans. Export a backup or a PDF, then free up space by deleting books you’ve already exported.', '手机已没有空间存放扫描。请导出备份或 PDF，再删除已导出的书以释放空间。'],
  'Salvataggio non riuscito. Riprova.': ['Couldn’t save. Try again.', '保存失败，请重试。'],

  // home
  'Impostazioni': ['Settings', '设置'],
  'Aggiungi Pageturn alla schermata Home': ['Add Pageturn to your Home Screen', '将 Pageturn 添加到主屏幕'],
  'Dal pulsante Condividi del browser (Safari, Opera, Chrome…) scegli «Aggiungi alla schermata Home».': ['Tap your browser’s Share button (Safari, Opera, Chrome…) and choose “Add to Home Screen”.', '在浏览器（Safari、Opera、Chrome…）的“分享”按钮中选择“添加到主屏幕”。'],
  'Installa l’app dal menu del browser.': ['Install the app from your browser’s menu.', '请从浏览器菜单中安装此应用。'],
  'Così le scansioni non vengono cancellate dal browser.': ['That way the browser won’t delete your scans.', '这样浏览器就不会删除你的扫描。'],
  'Nascondi': ['Hide', '隐藏'],
  'Opzioni': ['Options', '选项'],
  'Libri': ['Books', '书籍'],
  'Inizia il tuo primo libro': ['Start your first book', '开始扫描第一本书'],
  'Ogni pagina viene salvata appena la scatti, anche se l’app si chiude.': ['Every page is saved the moment you take it, even if the app closes.', '每一页拍下后立即保存，即使应用关闭也不会丢失。'],
  'Nuovo libro': ['New book', '新书'],
  'Crea e scansiona': ['Create and scan', '创建并扫描'],
  'Libro del {d}': ['Book from {d}', '{d}的书'],
  'Rinomina': ['Rename', '重命名'],
  'Esporta backup (.zip)': ['Export backup (.zip)', '导出备份 (.zip)'],
  'Elimina libro': ['Delete book', '删除书籍'],
  'Eliminare il libro?': ['Delete this book?', '删除这本书？'],
  '«{name}» e le sue {n} pagine verranno eliminati da questo dispositivo. Il backup sul server, se c’è, resta.': ['“{name}” and its {n} pages will be deleted from this device. The server backup, if there is one, stays.', '“{name}”及其 {n} 页将从此设备中删除。服务器上的备份（如有）会保留。'],
  'Libro eliminato': ['Book deleted', '已删除书籍'],
  'Preparo il backup…': ['Preparing backup…', '正在准备备份…'],
  'Backup pronto': ['Backup ready', '备份已就绪'],
  'Backup non riuscito: {e}': ['Backup failed: {e}', '备份失败：{e}'],

  // libro
  'errore': ['error', '错误'],
  'sfocata': ['blurry', '模糊'],
  'elaboro {n}': ['processing {n}', '正在处理 {n} 页'],
  'tutto salvato': ['all saved', '已全部保存'],
  'invio al server ({n})': ['sending to server ({n})', '正在上传到服务器 ({n})'],
  'copia sul server': ['backed up on server', '已备份到服务器'],
  'server non raggiungibile': ['server unreachable', '无法连接服务器'],
  'Importa foto': ['Import photos', '导入照片'],
  'Seleziona': ['Select', '选择'],
  'Altro': ['More', '更多'],
  'Nessuna': ['None', '全不选'],
  'Tutte': ['All', '全选'],
  'Seleziona pagine': ['Select pages', '选择页面'],
  'Riordina': ['Reorder', '排序'],
  'Scansiona': ['Scan', '扫描'],
  'Esporta': ['Export', '导出'],
  'Ruota': ['Rotate', '旋转'],
  'Filtro': ['Filter', '滤镜'],
  'Distendi': ['Unwarp', '展平'],
  'Tieni premuta una pagina e trascinala nella nuova posizione': ['Press and hold a page, then drag it to its new position', '按住页面，拖到新位置'],
  'Nessuna pagina': ['No pages yet', '还没有页面'],
  'Tocca Scansiona per iniziare, oppure importa foto dal rullino.': ['Tap Scan to start, or import photos from your camera roll.', '点按“扫描”开始，或从相册导入照片。'],
  'Riordina pagine': ['Reorder pages', '调整页面顺序'],
  'Seleziona prima le pagine': ['Select some pages first', '请先选择页面'],
  'Eliminare {pages}?': ['Delete {pages}?', '删除 {pages}？'],
  'Le pagine verranno eliminate da questo dispositivo.': ['The pages will be deleted from this device.', '这些页面将从此设备中删除。'],
  'Pagine non più distese': ['Pages no longer unwarped', '已取消页面展平'],
  'Distendo le pagine curve in background': ['Unwarping curved pages in the background', '正在后台展平弯曲的页面'],
  'Filtro per le pagine selezionate': ['Filter for the selected pages', '所选页面的滤镜'],
  'Originale': ['Original', '原图'],
  'Sbianca': ['Whiten', '增白'],
  'Grigi': ['Grayscale', '灰度'],
  'B/N': ['B/W', '黑白'],
  '{n} pagine senza una copia fuori dal telefono': ['{n} pages with no copy outside your phone', '{n} 页还没有在手机之外备份'],
  'Backup': ['Backup', '备份'],

  // fotocamera
  'Torcia': ['Flashlight', '手电筒'],
  'Avvio la fotocamera…': ['Starting camera…', '正在启动相机…'],
  'Rifai la pagina': ['Retake page', '重拍此页'],
  'Auto': ['Auto', '自动'],
  'Manuale': ['Manual', '手动'],
  'Doppia pagina': ['Double page', '双页'],
  'Vai alle pagine': ['Go to pages', '查看页面'],
  'Scatta': ['Take photo', '拍摄'],
  'Fotocamera di iOS': ['iOS Camera', 'iOS 相机'],
  'Gira pagina': ['Turn the page', '请翻页'],
  'Tocca il pulsante per scattare': ['Tap the button to take the photo', '点按按钮拍摄'],
  'Inquadra una pagina': ['Frame a page', '请对准一页'],
  'Pagina rilevata · scatta quando vuoi': ['Page found · shoot when ready', '已识别页面 · 随时拍摄'],
  'Tieni fermo': ['Hold still', '请保持不动'],
  'Pagina rilevata': ['Page found', '已识别页面'],
  'Pagina sostituita': ['Page replaced', '页面已替换'],
  'Fotocamera non disponibile': ['Camera unavailable', '相机不可用'],
  'La fotocamera funziona solo con un indirizzo https.': ['The camera only works on an https address.', '相机只能在 https 地址下使用。'],
  'Controlla di aver concesso il permesso di usare la fotocamera.': ['Check that you’ve allowed camera access.', '请确认已允许使用相机。'],
  'Usa la fotocamera di iOS': ['Use the iOS Camera', '使用 iOS 相机'],
  'Doppia pagina: ogni scatto diventa due pagine': ['Double page: each shot becomes two pages', '双页：每次拍摄生成两页'],
  'Una pagina per scatto': ['One page per shot', '每次拍摄一页'],

  // vista libera
  'Pagina': ['Page', '页面'],
  'Foto originale': ['Original photo', '原始照片'],
  'Pizzica o doppio tocco per ingrandire, trascina per spostarti': ['Pinch or double-tap to zoom, drag to move around', '双指缩放或轻点两下放大，拖动以移动'],
  'Immagine non disponibile: {e}': ['Image not available: {e}', '图片不可用：{e}'],

  // editor
  'Pagine': ['Pages', '页面'],
  'Pagina precedente': ['Previous page', '上一页'],
  'Pagina {i} di {n}': ['Page {i} of {n}', '第 {i} 页，共 {n} 页'],
  'Pagina successiva': ['Next page', '下一页'],
  'Annulla modifica': ['Undo', '撤销'],
  'Ripeti': ['Redo', '重做'],
  'Schermo intero con zoom': ['Full screen with zoom', '全屏缩放查看'],
  'Divisione annullata': ['Split undone', '已撤销拆分'],
  'Le modifiche valgono per tutte le pagine': ['Edits apply to all pages', '修改将应用于所有页面'],
  'Luminosità': ['Brightness', '亮度'],
  'Contrasto': ['Contrast', '对比度'],
  'Nitidezza': ['Sharpness', '锐度'],
  'Ritaglia': ['Crop', '裁剪'],
  'Dividi': ['Split', '拆分'],
  'Gomma': ['Eraser', '橡皮擦'],
  'Rifai': ['Retake', '重拍'],
  'Trascina gli angoli, o il centro di un lato per spostarlo tutto': ['Drag a corner, or the middle of a side to move all of it', '拖动四角，或拖动边的中点移动整条边'],
  'Rileva': ['Detect', '自动检测'],
  'Tutta la foto': ['Whole photo', '整张照片'],
  'Bordi non trovati: sistemali a mano': ['Edges not found: adjust them by hand', '未找到边缘，请手动调整'],
  'Passa il dito su macchie, segni e dita sul bordo': ['Swipe over stains, marks and fingers on the edge', '用手指涂抹污渍、笔迹和边缘的手指'],
  'Pennello': ['Brush', '笔刷'],
  'Annulla tratto': ['Undo stroke', '撤销笔画'],
  'Attendi l’anteprima aggiornata': ['Wait for the updated preview', '请等待预览更新'],
  'Scarico il modello per le pagine curve (31 MB), solo la prima volta': ['Downloading the curved-page model (31 MB), first time only', '正在下载弯曲页面模型（31 MB），仅首次需要'],
  'Pagina {i}': ['Page {i}', '第 {i} 页'],
  'Modifiche a tutte le pagine: attivo': ['Edits to all pages: on', '修改应用于所有页面：开'],
  'Modifiche a tutte le pagine: disattivo': ['Edits to all pages: off', '修改应用于所有页面：关'],
  'Filtro, luminosità, contrasto, nitidezza e Distendi ora valgono per tutte le pagine': ['Filter, brightness, contrast, sharpness and Unwarp now apply to all pages', '滤镜、亮度、对比度、锐度和展平现在应用于所有页面'],
  'Le modifiche valgono solo per questa pagina': ['Edits apply to this page only', '修改仅应用于此页'],
  'Nuova pagina dopo questa': ['New page after this one', '在此页后添加新页'],
  'Ripristina la foto originale': ['Restore the original photo', '恢复原始照片'],
  'Non è sfocata, togli l’avviso': ['It’s not blurry, remove the warning', '没有模糊，移除提示'],
  'Avviso rimosso': ['Warning removed', '已移除提示'],
  'Elimina pagina': ['Delete page', '删除页面'],
  'Eliminare la pagina?': ['Delete this page?', '删除此页？'],
  'La pagina {i} verrà eliminata.': ['Page {i} will be deleted.', '第 {i} 页将被删除。'],
  'Attendi l’anteprima della pagina': ['Wait for the page preview', '请等待页面预览'],
  'Sposta la linea sulla piega tra le due pagine. Trascina i cerchi per inclinarla': ['Move the line onto the fold between the two pages. Drag the circles to tilt it', '将线移到两页之间的折痕处。拖动圆点可使其倾斜'],
  'Pagina divisa in due': ['Page split in two', '页面已一分为二'],

  // esportazione
  'Immagini': ['Images', '图片'],
  'Ultimo backup': ['Last backup', '上次备份'],
  'Esporta progetto (.zip)': ['Export project (.zip)', '导出项目 (.zip)'],
  'Backup automatico': ['Automatic backup', '自动备份'],
  'non attivo': ['off', '未开启'],
  'in corso': ['in progress', '进行中'],
  'attivo': ['on', '已开启'],
  'Formato pagina': ['Page size', '页面尺寸'],
  'Come la foto': ['Same as photo', '与照片相同'],
  'A4 con margini': ['A4 with margins', 'A4 带边距'],
  'Ogni pagina viene centrata su un foglio A4 con 1 cm di margine: tutte della stessa misura, pronte da stampare.': ['Each page is centered on an A4 sheet with a 1 cm margin: all the same size, ready to print.', '每页居中放在 A4 纸上，边距 1 厘米：尺寸统一，可直接打印。'],
  'Testo ricercabile (OCR)': ['Searchable text (OCR)', '可搜索文字 (OCR)'],
  'Italiano': ['Italian', '意大利语'],
  'Inglese': ['English', '英语'],
  'Riconoscimento del testo': ['Text recognition', '文字识别'],
  'Preciso': ['Accurate', '精确'],
  'Veloce': ['Fast', '快速'],
  'Più preciso su foto, pagine curve e caratteri piccoli. Riconosce italiano, inglese e le altre lingue con alfabeto latino. La prima volta scarica circa 27 MB.': ['More accurate on photos, curved pages and small print. Reads Italian, English and other Latin-script languages. Downloads about 27 MB the first time.', '对照片、弯曲页面和小字更准确。可识别意大利语、英语及其他拉丁字母语言，暂不支持中文。首次使用需下载约 27 MB。'],
  'Circa tre volte più veloce, meno preciso sulle foto difficili. La prima volta scarica circa 10 MB.': ['About three times faster, less accurate on difficult photos. Downloads about 10 MB the first time.', '速度约快三倍，但对较难的照片不够准确。首次使用需下载约 10 MB。'],
  'Tutto avviene sul telefono, poi funziona anche offline.': ['It all happens on your phone, and afterwards it works offline too.', '全部在手机上完成，之后离线也能使用。'],
  'Qualità': ['Quality', '质量'],
  'Bassa': ['Low', '低'],
  'Media': ['Medium', '中'],
  'Alta': ['High', '高'],
  'Stima in corso…': ['Estimating…', '正在估算…'],
  'Crea PDF': ['Create PDF', '生成 PDF'],
  'Crea immagini (.zip)': ['Create images (.zip)', '生成图片 (.zip)'],
  'circa {size}': ['about {size}', '约 {size}'],
  'Scegli almeno una lingua': ['Choose at least one language', '请至少选择一种语言'],
  'Creo il PDF': ['Creating PDF', '正在生成 PDF'],
  'Preparo le immagini': ['Preparing images', '正在准备图片'],
  'Preparazione…': ['Preparing…', '准备中…'],
  'Tieni l’app aperta. Le pagine restano salvate anche se interrompi.': ['Keep the app open. Your pages stay saved even if you stop.', '请保持应用打开。即使中断，页面也已保存。'],
  'Finisco di elaborare le pagine ({n})…': ['Finishing page processing ({n})…', '正在完成页面处理 ({n})…'],
  'Preparo il riconoscimento del testo': ['Preparing text recognition', '正在准备文字识别'],
  'Riconosco il testo: pagina {i} di {n}': ['Recognizing text: page {i} of {n}', '正在识别文字：第 {i} 页，共 {n} 页'],
  'Impagino: {i} di {n}': ['Laying out pages: {i} of {n}', '正在排版：{i} / {n}'],
  'immagini': ['images', '图片'],
  'scansione': ['scan', '扫描'],
  'PDF pronto': ['PDF ready', 'PDF 已生成'],
  'Immagini pronte': ['Images ready', '图片已生成'],
  'Esportazione non riuscita: {e}': ['Export failed: {e}', '导出失败：{e}'],
  'Pagina non ancora elaborata': ['Page not processed yet', '页面尚未处理完成'],
  'Questo file non è un backup di Pageturn': ['This file isn’t a Pageturn backup', '此文件不是 Pageturn 备份'],
  '{name} (ripristino)': ['{name} (restored)', '{name}（恢复）'],

  // impostazioni
  'Aspetto': ['Appearance', '外观'],
  'Automatico': ['Automatic', '自动'],
  'Chiaro': ['Light', '浅色'],
  'Scuro': ['Dark', '深色'],
  'Lingua': ['Language', '语言'],
  'Automatica': ['Automatic', '自动'],
  'Backup automatico sul server': ['Automatic backup to your server', '自动备份到服务器'],
  'Attivo': ['On', '开启'],
  'Indirizzo': ['Address', '地址'],
  'Codice': ['Code', '访问码'],
  'facoltativo': ['optional', '可选'],
  'Stato': ['Status', '状态'],
  'Verifica connessione': ['Test connection', '测试连接'],
  'Ripristina dal server': ['Restore from server', '从服务器恢复'],
  'Ogni foto viene inviata al tuo server appena scattata, così resta una copia anche se perdi il telefono. Il server è incluso nel progetto (cartella server).': ['Every photo is sent to your server as soon as it’s taken, so a copy survives even if you lose your phone. The server is included in the project (server folder).', '每张照片拍下后立即发送到你的服务器，即使手机丢失也留有副本。服务器程序包含在项目中（server 文件夹）。'],
  'Archivio sul dispositivo': ['Storage on this device', '设备存储'],
  'Spazio usato': ['Space used', '已用空间'],
  '{used} di {quota}': ['{used} of {quota}', '{used} / {quota}'],
  'non disponibile': ['not available', '不可用'],
  'Protetto dalla pulizia': ['Protected from cleanup', '免于自动清理'],
  'sì': ['yes', '是'],
  'non confermato': ['not confirmed', '未确认'],
  'no, installa l’app': ['no, install the app', '否，请安装应用'],
  'Importa un backup (.zip)': ['Import a backup (.zip)', '导入备份 (.zip)'],
  'Informazioni': ['About', '关于'],
  'Versione': ['Version', '版本'],
  'Ambiente': ['Environment', '运行环境'],
  'Codice sorgente su GitHub': ['Source code on GitHub', 'GitHub 上的源代码'],
  'Pageturn è open source (licenza GPL-3.0). Le scansioni restano sul tuo dispositivo e sul tuo server: nessun dato passa da altri servizi.': ['Pageturn is open source (GPL-3.0 license). Your scans stay on your device and your server: no data goes through any other service.', 'Pageturn 是开源软件（GPL-3.0 许可证）。扫描内容只保存在你的设备和你的服务器上，不经过任何其他服务。'],
  'Server raggiungibile': ['Server reachable', '服务器连接正常'],
  'Server non raggiungibile: {err}': ['Server unreachable: {err}', '无法连接服务器：{err}'],
  'Importo il backup…': ['Importing backup…', '正在导入备份…'],
  '«{name}» importato': ['“{name}” imported', '已导入“{name}”'],
  'app installata': ['installed app', '已安装应用'],
  'offline sì': ['works offline', '可离线使用'],
  'offline no': ['no offline', '不可离线使用'],
  'OCR multithread': ['multithreaded OCR', '多线程 OCR'],
  'OCR a 1 thread': ['single-thread OCR', '单线程 OCR'],
  'invio in corso ({n})': ['sending ({n})', '正在上传 ({n})'],
  'tutto sul server': ['all on the server', '已全部备份到服务器'],
  'Sul server non ci sono libri': ['There are no books on the server', '服务器上没有书籍'],
  'Scarico…': ['Downloading…', '正在下载…'],
  'Scarico {i} di {n}…': ['Downloading {i} of {n}…', '正在下载 {i} / {n}…'],
  '«{name}» ripristinato': ['“{name}” restored', '已恢复“{name}”'],
  'Ripristino non riuscito: {err}': ['Restore failed: {err}', '恢复失败：{err}'],
  '{name} (dal server)': ['{name} (from server)', '{name}（来自服务器）'],
  'Codice di accesso errato': ['Wrong access code', '访问码错误'],
  'Non è un server Pageturn': ['Not a Pageturn server', '不是 Pageturn 服务器'],
  'Errore {status}': ['Error {status}', '错误 {status}'],
  'Errore del server ({status})': ['Server error ({status})', '服务器错误 ({status})'],
  'Sei offline': ['You’re offline', '当前处于离线状态'],
  'Progetto non trovato': ['Project not found', '找不到该项目'],

  // avvio
  'È pronta una nuova versione': ['A new version is ready', '新版本已就绪'],
  'Aggiorna': ['Update', '更新'],
  'Qualcosa non va': ['Something went wrong', '出了点问题'],
};

const COL = { en: 0, zh: 1 };

export function detectLang() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  for (const l of nav.languages || [nav.language]) {
    const c = String(l || '').slice(0, 2).toLowerCase();
    if (c === 'it' || c === 'en' || c === 'zh') return c;
  }
  return 'en';
}

// 'auto' segue la lingua del telefono; le altre lingue non previste diventano inglese.
export function setLang(p) {
  pref = LOCALES[p] ? p : 'auto';
  lang = pref === 'auto' ? detectLang() : pref;
  try { localStorage.setItem(KEY, pref); } catch { /* privato o worker */ }
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
}

export const langPref = () => pref;
export const currentLang = () => lang;
export const locale = () => LOCALES[lang];
// spazio tra due frasi: in cinese dopo 。 non si lascia spazio
export const sp = () => (lang === 'zh' ? '' : ' ');

export function tr(key, vars) {
  const row = lang === 'it' ? null : T[key];
  let s = (row && row[COL[lang]]) || key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

export function trp(n, one, many) {
  const row = lang === 'it' ? null : T[`${one}|${many}`];
  if (!row) return `${n} ${n === 1 ? one : many}`;
  const [o, m] = row[COL[lang]];
  return (n === 1 ? o : m).replace('{n}', n);
}

let saved = null;
try { saved = localStorage.getItem(KEY); } catch { /* */ }
setLang(saved || 'auto');
