import * as core from './core.js';
import * as api from './api.js';
import * as gist from './sync.js';

const LIB_KEY = 'sl_library';
const PREFS_KEY = 'sl_prefs';
const $view = document.getElementById('view');

// ---------- state ----------

let lib = loadLib();
let prefs = loadPrefs();
let route = { name: 'shelf', args: [] };
let renderToken = 0;

function loadLib() {
  try { return JSON.parse(localStorage.getItem(LIB_KEY)) || core.emptyLibrary(); } catch { return core.emptyLibrary(); }
}
function loadPrefs() {
  try { return { shelf: 'reading', sort: {}, ...JSON.parse(localStorage.getItem(PREFS_KEY)) }; } catch { return { shelf: 'reading', sort: {} }; }
}
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} }

// The lookup cache shares this storage. If it's full, the library wins: clear the cache and retry.
function persist() {
  const text = JSON.stringify(lib);
  try { localStorage.setItem(LIB_KEY, text); return; } catch {}
  api.clearCache();
  try { localStorage.setItem(LIB_KEY, text); } catch {
    toast(gist.settings().token ? "This device's storage is full. Changes are kept by sync only." : "This device's storage is full: your last change wasn't saved. Download a backup in Sync.");
  }
}

function putEntry(entry) {
  lib = { ...lib, books: { ...lib.books, [entry.id]: entry } };
  persist();
  scheduleSync();
}
const entryFor = id => (lib.books[id] && !lib.books[id].deleted ? lib.books[id] : null);

// ---------- helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.6 2.9 6 6.6.8-4.9 4.6 1.3 6.5L12 17.3l-5.9 3.2 1.3-6.5-4.9-4.6 6.6-.8z"/></svg>';

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

// Title-coloured stand-in when Open Library has no cover.
function fakeCover(title, author) {
  let h = 0;
  for (const c of title || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hues = [12, 28, 160, 200, 220, 260, 340, 95];
  const hue = hues[h % hues.length];
  return `<div class="fake" style="background:linear-gradient(160deg,hsl(${hue} 38% 38%),hsl(${hue} 42% 24%))"><b>${esc(title)}</b>${author ? `<i>${esc(author)}</i>` : ''}</div>`;
}

function coverHtml({ cover, title, author, status, pos, size = 'M' }) {
  const img = cover ? `<img src="${api.coverUrl(cover, size)}" alt="" loading="lazy" crossorigin="anonymous" onerror="this.remove()">` : '';
  return `<div class="cover">${fakeCover(title, author)}${img}${status ? `<span class="badge ${status}">${esc(core.STATUS_LABEL[status])}</span>` : ''}${pos != null && pos !== '' ? `<span class="pos">#${esc(pos)}</span>` : ''}</div>`;
}

function starsHtml(r) {
  if (!r) return '';
  return `<span class="stars" aria-label="${r} of 5 stars">${[1, 2, 3, 4, 5].map(i => `<span class="${i <= r ? '' : 'off'}">${STAR}</span>`).join('')}</span>`;
}

function tile(b, opts = {}) {
  const e = b.ol ? entryFor(b.ol) : entryFor(b.id);
  const id = b.ol || b.id;
  const status = opts.noBadge ? null : e?.status;
  const author = opts.author ?? (b.authors?.[0]?.name || '');
  const inner = `${coverHtml({ cover: b.cover ?? e?.cover, title: b.title, author, status, pos: opts.pos })}
    <div class="t">${esc(b.title)}</div>
    ${opts.sub ? `<div class="a">${opts.sub}</div>` : author ? `<div class="a">${esc(author)}</div>` : ''}${opts.extra ? `<div class="a">${opts.extra}</div>` : ''}`;
  if (id) return `<a class="tile${opts.dim && !e ? ' dim' : ''}" href="#/book/${esc(id)}">${inner}</a>`;
  // Wikidata knows the work but Open Library's id isn't linked: find it by title when tapped
  return `<button class="tile dim" data-act="find" data-title="${esc(b.title)}" data-author="${esc(opts.findAuthor || author)}">${inner}</button>`;
}

function loading() { $view.innerHTML = '<div class="spinner" role="progressbar" aria-label="Loading"></div>'; }

function failed(err, retry = true) {
  $view.innerHTML = `<div class="empty"><h2>Couldn't load that</h2><p>${esc(err.message || err)}</p>
    <p class="small muted">${navigator.onLine ? 'Open Library or Wikidata may be busy.' : "You're offline, and this page isn't saved on this device yet."}</p>
    ${retry ? '<p><button class="btn" data-act="retry">Try again</button></p>' : ''}</div>`;
}

// ---------- routing ----------

function parseRoute() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const decode = s => { try { return decodeURIComponent(s); } catch { return s; } }; // a stray % in a pasted link
  const parts = path.split('/').filter(Boolean).map(decode);
  return { name: parts[0] || 'shelf', args: parts.slice(1), query: new URLSearchParams(query) };
}

async function render() {
  route = parseRoute();
  const token = ++renderToken;
  const tab = { shelf: 'shelf', search: 'search', scan: 'scan', stats: 'stats', settings: 'settings' }[route.name];
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  if (route.name !== 'scan') stopScan();
  const views = { shelf: viewShelf, search: viewSearch, scan: viewScan, book: viewBook, author: viewAuthor, series: viewSeries, stats: viewStats, settings: viewSettings };
  const fn = views[route.name] || viewShelf;
  try {
    await fn(token, ...route.args);
  } catch (err) {
    if (token === renderToken) failed(err);
  }
}
const current = token => token === renderToken;

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

// ---------- shelves ----------

function viewShelf(token, which) {
  const counts = Object.fromEntries(core.STATUSES.map(s => [s, core.shelf(lib, s).length]));
  let status = core.STATUSES.includes(which) ? which : prefs.shelf;
  if (!which && !counts[status]) status = ['reading', 'want', 'read', 'dropped'].find(s => counts[s]) || 'reading';
  prefs.shelf = status; savePrefs();
  const sort = prefs.sort[status] || (status === 'read' ? 'finished' : 'added');
  const total = core.liveBooks(lib).length;
  const filter = shelfFilter;
  const books = core.shelf(lib, status, sort, filter);

  if (!total) {
    $view.innerHTML = `<div class="empty"><h2>Your shelves are empty</h2>
      <p>Search for a book, or scan the barcode on the back of one you own.</p>
      <p class="row" style="justify-content:center;margin-top:18px"><a class="btn primary" href="#/search">Search books</a><a class="btn" href="#/scan">Scan a barcode</a></p>
      <p class="small muted" style="margin-top:24px">Already set up on another device? <a href="#/settings">Turn on sync</a> to bring your books here.</p></div>`;
    return;
  }

  $view.innerHTML = `
    <div id="upnext"></div>
    <div class="seg" role="tablist">${core.STATUSES.map(s => `<a role="tab" href="#/shelf/${s}" class="${s === status ? 'on' : ''}" aria-selected="${s === status}">${core.STATUS_LABEL[s]}<span class="count">${counts[s]}</span></a>`).join('')}</div>
    <div class="shelf-tools">
      <input type="search" id="shelf-filter" placeholder="Filter this shelf" value="${esc(filter)}" aria-label="Filter this shelf">
      <select id="shelf-sort" aria-label="Sort">${Object.entries(core.SORT_LABEL).filter(([k]) => k !== 'finished' || status === 'read').map(([k, l]) => `<option value="${k}" ${k === sort ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="grid" id="shelf-grid">${shelfTiles(books, status)}</div>`;

  document.getElementById('shelf-filter').addEventListener('input', e => {
    shelfFilter = e.target.value;
    document.getElementById('shelf-grid').innerHTML = shelfTiles(core.shelf(lib, status, sort, shelfFilter), status);
  });
  document.getElementById('shelf-sort').addEventListener('change', e => { prefs.sort[status] = e.target.value; savePrefs(); render(); });
  renderUpNext(token);
}
let shelfFilter = '';

function shelfTiles(books, status) {
  if (!books.length) return `<p class="muted" style="grid-column:1/-1">${shelfFilter ? 'Nothing matches that.' : `Nothing on ${core.STATUS_LABEL[status]} yet.`}</p>`;
  return books.map(b => {
    const done = core.lastRead(b);
    const extra = status === 'read' ? [done ? esc(fmtDate(done, true)) : '', starsHtml(b.rating)].filter(Boolean).join('</div><div class="a">') : '';
    return tile(b, { noBadge: true, sub: esc(b.authors[0]?.name || ''), extra });
  }).join('');
}

// "Up next in your series": for series you've started, the next book you haven't read.
// Uses series already fetched; fetches a few more in the background each visit.
async function renderUpNext(token) {
  const ids = [...new Set(core.liveBooks(lib).filter(b => b.status === 'read').flatMap(b => (b.series || []).map(s => s.id)))];
  const draw = () => {
    if (!current(token)) return;
    const items = [];
    for (const id of ids) {
      const s = api.cachedSeries(id);
      if (!s) continue;
      const next = core.nextInSeries(s.books, lib);
      if (next && !(next.ol && entryFor(next.ol)?.status === 'read')) items.push({ s, next });
    }
    const box = document.getElementById('upnext');
    if (!box) return;
    if (!items.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="section" style="margin-top:4px"><h2>Up next in your series</h2></div>
      <div class="strip upnext">${items.slice(0, 20).map(({ s, next }) => tile({ ...next, id: next.ol }, { pos: next.pos, sub: esc(s.name), findAuthor: next.authors?.[0] })).join('')}</div>`;
    fillCovers(box, items.map(i => i.next.ol));
  };
  draw();
  const missing = ids.filter(id => !api.cachedSeries(id)).slice(0, 6);
  if (!missing.length || !navigator.onLine) return;
  await Promise.allSettled(missing.map(id => api.series(id)));
  draw();
}

// Wikidata gives titles but not covers: fill tile covers from Open Library afterwards.
async function fillCovers(root, olIds) {
  const docs = await api.docsForWorks(olIds.filter(Boolean));
  root.querySelectorAll('a.tile[href^="#/book/"]').forEach(a => {
    const id = a.getAttribute('href').split('/').pop();
    const d = docs[id];
    const cov = a.querySelector('.cover');
    if (!d?.cover || cov.querySelector('img')) return;
    const img = Object.assign(document.createElement('img'), { src: api.coverUrl(d.cover), alt: '', loading: 'lazy', crossOrigin: 'anonymous' });
    img.onerror = () => img.remove();
    cov.insertBefore(img, cov.querySelector('.badge, .pos'));
  });
}

function fmtDate(iso, short) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, short ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---------- search ----------

let lastSearch = { q: '', results: [] };

async function viewSearch(token) {
  const q = route.query.get('q') || '';
  $view.innerHTML = `
    <form class="searchbar" id="search-form" role="search">
      <input type="search" name="q" id="q" placeholder="Title, author or ISBN" value="${esc(q)}" autocomplete="off" enterkeyhint="search" aria-label="Search books">
      <button class="btn primary" type="submit">Search</button>
    </form>
    <div id="results"></div>`;
  const input = document.getElementById('q');
  if (!q) input.focus();
  document.getElementById('search-form').addEventListener('submit', e => {
    e.preventDefault();
    const v = input.value.trim();
    if (v) location.hash = `#/search?q=${encodeURIComponent(v)}`;
    input.blur();
  });
  if (!q) {
    document.getElementById('results').innerHTML = '<p class="muted">Search Open Library\'s catalogue of millions of books. Tip: an ISBN finds the exact edition.</p>';
    return;
  }
  const box = document.getElementById('results');
  let results;
  if (lastSearch.q === q) results = lastSearch.results;
  else {
    box.innerHTML = '<div class="spinner"></div>';
    results = await api.search(q);
    lastSearch = { q, results };
  }
  if (!current(token)) return;
  if (!results.length) { box.innerHTML = '<p class="muted">No books found. Try fewer words, or just the author\'s surname and a title word.</p>'; return; }
  box.innerHTML = `<div class="results">${results.map(resultRow).join('')}</div>`;
}

function resultRow(b) {
  const e = entryFor(b.id);
  return `<div class="result">
    <a href="#/book/${esc(b.id)}" aria-label="${esc(b.title)}">${coverHtml({ cover: b.cover, title: b.title })}</a>
    <a href="#/book/${esc(b.id)}" style="text-decoration:none;min-width:0">
      <h3>${esc(b.title)}</h3>
      <div class="by">${esc(b.authors.map(a => a.name).slice(0, 2).join(', '))}</div>
      <div class="yr">${b.year || ''}${b.editions > 1 ? ` · ${b.editions} editions` : ''}</div>
    </a>
    ${e ? `<span class="badge ${e.status}">${core.STATUS_LABEL[e.status]}</span>` : `<button class="btn small" data-act="quick-want" data-id="${esc(b.id)}">+ Want</button>`}
  </div>`;
}

async function addBook(id, status, meta) {
  const existing = lib.books[id];
  const [workRes, seriesRes] = await Promise.allSettled([meta || api.work(id), api.seriesForWork(id)]);
  const m = workRes.value;
  if (!m) { toast("Couldn't reach Open Library"); return null; }
  const seriesChecked = seriesRes.status === 'fulfilled';
  const series = seriesChecked ? seriesRes.value : [];
  const entry = existing && !existing.deleted ? core.setStatus(existing, status) : { ...core.newEntry({ ...m, id, series }, status), seriesChecked };
  putEntry(entry);
  return entry;
}

// ---------- scan ----------

let scanReader = null;
let scanStream = null;

async function viewScan(token) {
  $view.innerHTML = `
    <h1 class="page-title">Scan a book</h1>
    <div class="scanner" id="scanner"><video id="cam" playsinline muted></video><div class="frame"></div></div>
    <p class="scan-msg" id="scan-msg">Starting the camera…</p>
    <form class="manual card" id="isbn-form">
      <label class="field" for="isbn" style="margin-top:0">Or type the ISBN</label>
      <div class="row" style="flex-wrap:nowrap"><input type="text" id="isbn" inputmode="numeric" placeholder="978…" autocomplete="off"><button class="btn primary" type="submit">Find</button></div>
    </form>`;
  document.getElementById('isbn-form').addEventListener('submit', e => {
    e.preventDefault();
    const isbn = core.cleanIsbn(document.getElementById('isbn').value);
    if (!isbn) { toast("That isn't a valid ISBN"); return; }
    lookupIsbn(isbn);
  });
  const msg = document.getElementById('scan-msg');
  if (!navigator.mediaDevices?.getUserMedia) {
    document.getElementById('scanner').classList.add('hidden');
    msg.textContent = "This browser can't use the camera here. Type the ISBN instead.";
    return;
  }
  try {
    await startScan(token, msg);
  } catch (err) {
    if (!current(token)) return;
    document.getElementById('scanner').classList.add('hidden');
    msg.textContent = err.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in your browser settings, or type the ISBN.' : "Couldn't start the camera. Type the ISBN instead.";
  }
}

async function startScan(token, msg) {
  const video = document.getElementById('cam');
  const onCode = code => {
    if (!core.isBookBarcode(code)) { msg.textContent = 'That barcode isn\'t an ISBN. Try the one starting 978 or 979.'; return false; }
    if (navigator.vibrate) navigator.vibrate(60);
    stopScan();
    lookupIsbn(core.cleanIsbn(code));
    return true;
  };
  // Chrome on Android/desktop has a native detector; Safari (iPhone, Mac) needs the ZXing library.
  const native = 'BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats?.())?.includes('ean_13');
  if (!native && !window.ZXing) await loadScript('vendor/zxing.min.js');
  if (!current(token)) return;
  // Open the camera here for both paths, so leaving the page while it starts always switches it off
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } } });
  if (!current(token) || route.name !== 'scan') { stream.getTracks().forEach(t => t.stop()); return; }
  stopScan();
  scanStream = stream;
  if (native) {
    video.srcObject = scanStream;
    await video.play();
    msg.textContent = 'Point the camera at the barcode on the back cover.';
    const det = new BarcodeDetector({ formats: ['ean_13'] });
    const tick = async () => {
      if (!scanStream || !current(token)) return;
      try {
        const codes = await det.detect(video);
        if (codes[0] && onCode(codes[0].rawValue)) return;
      } catch {}
      setTimeout(tick, 150);
    };
    tick();
    return;
  }
  const hints = new Map([[ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13]], [ZXing.DecodeHintType.TRY_HARDER, true]]);
  scanReader = new ZXing.BrowserMultiFormatReader(hints, 200);
  msg.textContent = 'Point the camera at the barcode on the back cover.';
  // Runs until stopScan() resets the reader; not awaited
  scanReader.decodeFromStream(scanStream, video, result => {
    if (result) onCode(result.getText());
  }).catch(() => {});
}

function stopScan() {
  if (scanReader) { try { scanReader.reset(); } catch {} scanReader = null; }
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
}

function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = Object.assign(document.createElement('script'), { src, onload: ok, onerror: () => fail(new Error('Scanner failed to load')) });
    document.head.append(s);
  });
}

async function lookupIsbn(isbn) {
  const msg = document.getElementById('scan-msg');
  if (msg) msg.textContent = `Looking up ${isbn}…`;
  try {
    const id = await api.workForIsbn(isbn);
    if (id) { location.hash = `#/book/${id}`; return; }
    if (msg) msg.textContent = `Open Library doesn't know ISBN ${isbn}. Try searching by title.`;
    toast('No match for that ISBN');
  } catch {
    if (msg) msg.textContent = "Couldn't reach Open Library. Check your connection.";
  }
  if (route.name === 'scan' && !scanReader && !scanStream) setTimeout(() => route.name === 'scan' && render(), 2500);
}

// ---------- book page ----------

async function viewBook(token, id) {
  const e = entryFor(id);
  if (!e) loading();
  else drawBook(id, e, null);
  // Book details (Open Library) and series (Wikidata) are separate services: ask both at once.
  // Series is needed for books not in the library, and for entries added offline that never looked it up.
  const needSeries = !e || (!e.seriesChecked && navigator.onLine);
  const [workRes, seriesRes] = await Promise.allSettled([api.work(id), needSeries ? api.seriesForWork(id) : null]);
  if (workRes.status === 'rejected' && !e) throw workRes.reason;
  const w = workRes.value || null;
  if (!current(token)) return;
  let entry = entryFor(id);
  if (entry && !entry.seriesChecked && seriesRes.status === 'fulfilled' && seriesRes.value) {
    entry = { ...entry, series: seriesRes.value, seriesChecked: true };
    lib = { ...lib, books: { ...lib.books, [id]: entry } };
    persist(); // not a user edit: no sync, no updated bump
  }
  const series = entry ? entry.series : seriesRes.status === 'fulfilled' && seriesRes.value ? seriesRes.value : [];
  drawBook(id, entry, w, series);
}

function drawBook(id, e, w, seriesList) {
  const m = { ...(w || {}), ...(e ? { title: e.title, authors: e.authors.length ? e.authors : w?.authors || [], cover: e.cover ?? w?.cover, pages: e.pages ?? w?.pages, year: e.year ?? w?.year } : {}) };
  const series = seriesList ?? e?.series ?? [];
  const status = e?.status;
  const authors = (m.authors || []).map(a => a.id ? `<a href="#/author/${esc(a.id)}">${esc(a.name)}</a>` : esc(a.name)).join(', ');
  const desc = w?.description || '';
  const scroll = window.scrollY;
  const notesFocused = document.activeElement?.id === 'notes';
  if (notesFocused) return; // don't redraw under someone typing

  $view.innerHTML = `
    <div class="book-head">
      ${coverHtml({ cover: m.cover, title: m.title, author: m.authors?.[0]?.name, size: 'L' })}
      <div>
        <h1>${esc(m.title)}</h1>
        <div class="by">${authors ? `by ${authors}` : ''}</div>
        <div class="facts">${m.year ? `<span>First published ${m.year}</span>` : ''}${m.pages ? `<span>${m.pages} pages</span>` : ''}</div>
        ${series.length ? `<div class="chips">${series.map(s => `<a class="chip" href="#/series/${esc(s.id)}">${s.pos != null ? `Book ${esc(s.pos)} · ` : ''}${esc(s.name)}</a>`).join('')}</div>` : ''}
      </div>
      <div class="status-wrap">
        <div class="seg status-seg" role="group" aria-label="Shelf">${core.STATUSES.map(s => `<button data-act="status" data-status="${s}" class="${s === status ? 'on' : ''}" aria-pressed="${s === status}">${core.STATUS_LABEL[s]}</button>`).join('')}</div>
        ${!e ? '<p class="small muted" style="margin:8px 2px 0">Pick a shelf to add it to your library.</p>' : ''}
      </div>
    </div>
    ${e ? mineHtml(e) : ''}
    ${desc ? `<div class="section"><h2>About the book</h2></div><div class="desc ${desc.length > 600 ? 'clamp' : ''}" id="desc">${esc(desc)}</div>${desc.length > 600 ? '<button class="linkish" data-act="more-desc" style="margin-top:6px">Read more</button>' : ''}` : ''}
    ${w?.subjects?.length ? `<div class="chips" style="margin-top:16px">${w.subjects.map(s => `<a class="chip plain" href="#/search?q=${encodeURIComponent('subject:"' + s + '"')}">${esc(s)}</a>`).join('')}</div>` : ''}
    ${(m.authors || []).filter(a => a.id).slice(0, 1).map(a => `<p style="margin-top:22px"><a class="btn" href="#/author/${esc(a.id)}">More by ${esc(a.name)} →</a></p>`).join('')}
    ${e ? `<p style="margin-top:28px"><button class="btn danger small" data-act="remove">Remove from library</button></p>` : ''}
    <p class="source">Book details: <a href="https://openlibrary.org/works/${esc(id)}" target="_blank" rel="noopener">Open Library</a>${series.length ? ' · Series: Wikidata' : ''}</p>`;
  window.scrollTo(0, scroll);

  const notes = document.getElementById('notes');
  if (notes) {
    let t;
    notes.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { const cur = entryFor(id); if (cur) putEntry(core.update(cur, { notes: notes.value })); }, 600);
    });
    notes.addEventListener('blur', () => { const cur = entryFor(id); if (cur && cur.notes !== notes.value) putEntry(core.update(cur, { notes: notes.value })); });
  }
  document.querySelectorAll('.read-row input').forEach(inp => inp.addEventListener('change', () => {
    const cur = entryFor(id);
    const reads = cur.reads.map(r => ({ ...r }));
    reads[+inp.dataset.i][inp.dataset.k] = inp.value || null;
    putEntry(core.update(cur, { reads }));
  }));
}

function mineHtml(e) {
  return `<div class="mine">
    <div class="card">
      <h2 style="font-size:19px">Your rating</h2>
      <div class="rate" role="group" aria-label="Rating">${[1, 2, 3, 4, 5].map(i => `<button data-act="rate" data-r="${i}" class="${i <= e.rating ? 'on' : ''}" aria-label="${i} star${i > 1 ? 's' : ''}" aria-pressed="${i === e.rating}">${STAR}</button>`).join('')}</div>
      <h2 style="font-size:19px;margin-top:18px">Reading dates</h2>
      <div class="reads" style="margin-top:8px">
        ${e.reads.length ? e.reads.map((r, i) => `<div class="read-row">
            <input type="date" aria-label="Started" data-i="${i}" data-k="start" value="${esc(r.start || '')}">
            <span class="muted">to</span>
            <input type="date" aria-label="Finished" data-i="${i}" data-k="end" value="${esc(r.end || '')}">
            <button class="x" data-act="del-read" data-i="${i}" aria-label="Delete this read">×</button></div>`).join('')
          : '<p class="muted small" style="margin:0">Dates fill in when you start and finish it.</p>'}
      </div>
      <div class="row" style="margin-top:10px">
        ${e.status === 'read' ? '<button class="btn small" data-act="read-again">Read it again</button>' : ''}
        <button class="btn small" data-act="add-read">Add dates</button>
      </div>
    </div>
    <div class="card">
      <label for="notes" style="font:600 19px var(--serif)">Notes</label>
      <textarea id="notes" placeholder="Thoughts, quotes, who lent it to you…" style="margin-top:10px">${esc(e.notes)}</textarea>
    </div>
  </div>`;
}

// ---------- author page ----------

async function viewAuthor(token, id) {
  loading();
  const a = await api.author(id);
  if (!current(token)) return;
  const head = `<div class="person">
      <div class="photo">${a.photo ? `<img src="${api.authorPhotoUrl(a.photo)}" alt="" crossorigin="anonymous" onerror="this.remove()">` : ''}${a.photo ? '' : esc((a.name || '?')[0])}</div>
      <div>
        <h1>${esc(a.name)}</h1>
        <div class="facts" style="margin-top:6px">${a.born ? `<span>Born ${esc(a.born)}</span>` : ''}${a.died ? `<span>Died ${esc(a.died)}</span>` : ''}</div>
        <div id="author-progress"></div>
      </div>
    </div>
    ${a.bio ? `<div class="desc clamp" id="desc" style="margin-top:18px">${esc(a.bio)}</div>${a.bio.length > 400 ? '<button class="linkish" data-act="more-desc" style="margin-top:6px">Read more</button>' : ''}` : ''}`;
  $view.innerHTML = head + '<div class="spinner"></div>';
  let works;
  try { works = await api.authorWorks(a); } catch (err) { if (!current(token)) return; $view.innerHTML = head + `<p class="muted" style="margin-top:24px">Couldn't load their books: ${esc(err.message)}</p>`; return; }
  if (!current(token)) return;

  // Books in your library by this author that Wikidata didn't list (or listed without an OL link)
  const known = new Set([...works.series.flatMap(s => s.books), ...works.novels, ...works.other].map(b => b.ol).filter(Boolean));
  const extra = core.liveBooks(lib).filter(b => b.authors.some(x => x.id === id) && !known.has(b.id));
  const all = [...new Map([...works.series.flatMap(s => s.books), ...works.novels].map(b => [b.wd || b.ol, b])).values()];
  const readCount = all.filter(b => b.ol && entryFor(b.ol)?.status === 'read').length + extra.filter(b => b.status === 'read').length;
  const totalCount = all.length + extra.length;

  const bigSeries = works.series.filter(s => s.books.length > 1 || s.books.some(b => b.ol && entryFor(b.ol)));
  const loneSeries = works.series.filter(s => !bigSeries.includes(s));
  const novels = [...works.novels, ...loneSeries.flatMap(s => s.books)].sort((x, y) => (x.year || 9999) - (y.year || 9999));
  const authorName = a.name;

  $view.innerHTML = head + `
    ${bigSeries.map(s => {
      const read = s.books.filter(b => b.ol && entryFor(b.ol)?.status === 'read').length;
      return `<div class="section"><h2><a href="#/series/${esc(s.id)}">${esc(s.name)}</a></h2><span class="meta">${s.books.length} books${read ? ` · ${read} read` : ''}</span></div>
      <div class="strip">${s.books.map(b => tile(b, { pos: b.pos, author: '', sub: b.year ? String(b.year) : '', dim: true, findAuthor: authorName })).join('')}</div>`;
    }).join('')}
    ${novels.length ? `<div class="section"><h2>${bigSeries.length ? 'Standalone books' : 'Books'}</h2><span class="meta">${novels.length}</span></div>
      <div class="grid">${novels.map(b => tile(b, { author: '', sub: b.year ? String(b.year) : '', dim: true, findAuthor: authorName })).join('')}</div>` : ''}
    ${extra.length ? `<div class="section"><h2>Also in your library</h2></div><div class="grid">${extra.map(b => tile(b, { author: '' })).join('')}</div>` : ''}
    ${works.other.length ? `<details class="more"><summary>Short fiction and other writing (${works.other.length})</summary>
      <div class="list">${works.other.map(b => b.ol ? `<a class="li" href="#/book/${esc(b.ol)}"><span>${esc(b.title)}</span>${b.ol && entryFor(b.ol) ? `<span class="badge ${entryFor(b.ol).status}">${core.STATUS_LABEL[entryFor(b.ol).status]}</span>` : ''}<span class="yr">${b.year || ''}</span></a>` : `<button class="li" data-act="find" data-title="${esc(b.title)}" data-author="${esc(authorName)}"><span>${esc(b.title)}</span><span class="yr">${b.year || ''}</span></button>`).join('')}</div></details>` : ''}
    <p class="source">${works.source === 'wikidata' ? 'Bibliography and series: Wikidata. Covers and details: Open Library.' : 'Books: Open Library (no series information for this author).'} ${api.webUrl(a.wikipedia) ? `· <a href="${esc(api.webUrl(a.wikipedia))}" target="_blank" rel="noopener">Wikipedia</a>` : ''}</p>`;

  document.getElementById('author-progress').innerHTML = totalCount ? `<div class="progress" aria-hidden="true"><span style="width:${Math.round(100 * readCount / totalCount)}%"></span></div><div class="small muted">You've read ${readCount} of ${totalCount} books</div>` : '';
  fillCovers($view, [...all, ...works.other].map(b => b.ol));
}

// ---------- series page ----------

async function viewSeries(token, id) {
  loading();
  const s = await api.series(id);
  if (!current(token)) return;
  if (!s.books.length) { $view.innerHTML = '<div class="empty"><h2>No books listed</h2><p>Wikidata has this series but no books in it yet.</p></div>'; return; }
  const authors = [...new Set(s.books.flatMap(b => b.authors))];
  const main = s.books.some(b => b.pos != null) ? s.books.filter(b => b.pos != null) : s.books;
  const read = main.filter(b => b.ol && entryFor(b.ol)?.status === 'read').length;
  const next = core.nextInSeries(s.books, lib);
  const first = !read ? main.find(b => !(b.ol && entryFor(b.ol))) : null;
  const pick = next || first;
  const years = s.books.map(b => b.year).filter(Boolean);
  const numbered = s.books.filter(b => b.pos != null), unnumbered = s.books.filter(b => b.pos == null);
  const seriesTile = b => tile(b, { pos: b.pos, author: '', sub: [b.year, authors.length > 1 ? b.authors[0] : ''].filter(Boolean).map(esc).join(' · '), dim: true, findAuthor: b.authors[0] });
  $view.innerHTML = `
    <h1 class="page-title" style="margin-bottom:4px">${esc(s.name || 'Series')}</h1>
    <div class="facts">${authors.length ? `<span>${esc(authors.slice(0, 3).join(', '))}${authors.length > 3 ? ' and others' : ''}</span>` : ''}<span>${main.length} books</span>${years.length ? `<span>${Math.min(...years)}${Math.max(...years) > Math.min(...years) ? `–${Math.max(...years)}` : ''}</span>` : ''}</div>
    <div class="progress" aria-hidden="true"><span style="width:${Math.round(100 * read / main.length)}%"></span></div>
    <div class="small muted">You've read ${read} of ${main.length}</div>
    ${pick ? `<div class="next-card card">${tile(pick, { noBadge: true, author: '', findAuthor: authors[0] })}<div><div class="eyebrow">${next ? 'Up next' : 'Start here'}</div><h3>${esc(pick.title)}</h3>
      ${pick.ol && !entryFor(pick.ol) ? `<button class="btn small primary" data-act="quick-want" data-id="${esc(pick.ol)}">+ Want to read</button>` : pick.ol ? `<span class="badge ${entryFor(pick.ol).status}">${core.STATUS_LABEL[entryFor(pick.ol).status]}</span>` : ''}</div></div>` : ''}
    ${s.subseries?.length ? `<div class="chips" style="margin-top:18px"><span class="muted small" style="align-self:center">Within this series:</span>${s.subseries.map(x => `<a class="chip" href="#/series/${esc(x.id)}">${esc(x.name)}</a>`).join('')}</div>` : ''}
    ${numbered.length ? `<div class="section"><h2>${unnumbered.length ? 'In order' : 'Books'}</h2></div><div class="grid">${numbered.map(seriesTile).join('')}</div>` : ''}
    ${unnumbered.length ? `<div class="section"><h2>${numbered.length ? 'Also in the series' : 'Books'}</h2>${numbered.length ? '<span class="meta">companions, short fiction and books Wikidata hasn\'t numbered</span>' : ''}</div><div class="grid">${unnumbered.map(seriesTile).join('')}</div>` : ''}
    <p class="source">Series order: <a href="https://www.wikidata.org/wiki/${esc(id)}" target="_blank" rel="noopener">Wikidata</a>. Covers: Open Library. Numbering follows Wikidata; books with no number go last.</p>`;
  // The next-card tile is a full tile; shrink it
  const nc = $view.querySelector('.next-card .tile');
  if (nc) nc.querySelectorAll('.t,.a').forEach(x => x.remove());
  fillCovers($view, s.books.map(b => b.ol));
}

// ---------- stats ----------

function viewStats() {
  const st = core.stats(lib);
  if (!st.total && !st.want && !st.reading) {
    $view.innerHTML = '<div class="empty"><h2>No stats yet</h2><p>Finish a book and it shows up here.</p></div>';
    return;
  }
  const maxY = Math.max(1, ...st.years.map(y => y.books));
  const maxR = Math.max(1, ...st.ratings.map(r => r.count));
  $view.innerHTML = `
    <h1 class="page-title">Stats</h1>
    <div class="kpis">
      <div class="card kpi"><div class="n">${st.total}</div><div class="l">Books read</div></div>
      <div class="card kpi"><div class="n">${st.pages.toLocaleString()}</div><div class="l">Pages read</div></div>
      <div class="card kpi"><div class="n">${st.want}</div><div class="l">Want to read</div></div>
      <div class="card kpi"><div class="n">${st.average ? st.average.toFixed(1) : '–'}</div><div class="l">Average rating</div></div>
    </div>
    ${st.years.length ? `<div class="section"><h2>By year finished</h2></div>
      <div class="bars">${st.years.map(y => `<div class="bar"><span>${y.year}</span><div class="track"><div class="fill" style="width:${100 * y.books / maxY}%"></div></div><span class="v">${y.books} book${y.books > 1 ? 's' : ''}</span></div>`).join('')}</div>
      <p class="small muted">Re-reads count in the year you finished them. Pages use Open Library's typical page count.</p>` : ''}
    ${st.ratings.some(r => r.count) ? `<div class="section"><h2>Your ratings</h2></div>
      <div class="bars">${st.ratings.map(r => `<div class="bar"><span class="stars">${STAR.repeat(1)}${r.rating}</span><div class="track"><div class="fill" style="width:${100 * r.count / maxR}%;background:var(--star)"></div></div><span class="v">${r.count}</span></div>`).join('')}</div>` : ''}
    ${st.authors.length ? `<div class="section"><h2>Most-read authors</h2></div>
      <div class="list">${st.authors.map(a => `<a class="li" ${a.id ? `href="#/author/${esc(a.id)}"` : ''}><span>${esc(a.name)}</span><span class="yr">${a.count} book${a.count > 1 ? 's' : ''}</span></a>`).join('')}</div>` : ''}`;
}

// ---------- settings / sync ----------

function viewSettings() {
  const s = gist.settings();
  const n = core.liveBooks(lib).length;
  $view.innerHTML = `
    <h1 class="page-title">Sync and backup</h1>
    <div class="settings">
      <div class="card">
        <h2>Sync between devices</h2>
        ${s.token ? `
          <p>Syncing through a private GitHub gist. ${s.last ? `Last synced ${new Date(s.last).toLocaleString()}.` : 'Not synced yet.'}</p>
          <p id="sync-err" class="small" style="color:var(--accent)">${esc(syncError || '')}</p>
          <div class="row"><button class="btn primary" data-act="sync-now">Sync now</button><button class="btn" data-act="disconnect">Turn off on this device</button></div>
          <p class="small muted">Turning off only forgets the token here. Your books stay on this device and in the gist.</p>`
        : `
          <p>Your books are saved on this device. To see them on your PC, Mac and iPhone, connect each one to the same GitHub account. The library is kept in one private gist there.</p>
          <ol>
            <li>On GitHub, go to <a href="https://github.com/settings/tokens/new?scopes=gist&description=Shelf%20Life" target="_blank" rel="noopener">Settings → Developer settings → Tokens (classic) → Generate new token</a>.</li>
            <li>Tick only <code>gist</code>. Set the expiry to "No expiration", or remember to make a new one when it expires.</li>
            <li>Paste the token below. Do the same on each device; they find each other automatically.</li>
          </ol>
          <form id="token-form"><label class="field" for="token">GitHub token</label>
            <div class="row" style="flex-wrap:nowrap"><input type="password" id="token" autocomplete="off" placeholder="ghp_…" spellcheck="false"><button class="btn primary" type="submit">Connect</button></div></form>
          <p class="small muted">The token stays on this device and is only ever sent to GitHub. It can read and write your gists and nothing else.</p>`}
      </div>
      <div class="card">
        <h2>Backup</h2>
        <p>${n} book${n === 1 ? '' : 's'} on this device. Download a copy, or load one back in. Loading merges: nothing already here is lost.</p>
        <div class="row"><button class="btn" data-act="export">Download backup</button><label class="btn">Load backup<input type="file" id="import" accept="application/json,.json" hidden></label></div>
      </div>
      <div class="card">
        <h2>Where the data comes from</h2>
        <p>Books, covers and authors: <a href="https://openlibrary.org" target="_blank" rel="noopener">Open Library</a>. Series and reading order: <a href="https://www.wikidata.org" target="_blank" rel="noopener">Wikidata</a>. Both are free and edited by volunteers, so lesser-known books may have no cover or series. Fixing them there fixes them here.</p>
      </div>
    </div>`;
  document.getElementById('token-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const token = document.getElementById('token').value.trim();
    if (!token) return;
    const btn = e.submitter; btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      await gist.connect(token);
      await runSync();
      toast(syncError ? syncError : 'Sync is on');
    } catch (err) {
      gist.disconnect();
      toast(err.message);
    }
    render();
  });
  document.getElementById('import')?.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const incoming = core.parseBackup(await f.text());
      const before = core.liveBooks(lib).length;
      lib = core.merge(lib, incoming).merged;
      persist(); scheduleSync();
      toast(`Loaded. ${core.liveBooks(lib).length - before} new book(s).`);
      render();
    } catch (err) { toast(err.message); }
  });
}

let syncError = '';
let syncing = false;
let syncAgain = false;
let syncTimer = null;

function setDot(state, title) {
  const d = document.getElementById('sync-dot');
  d.className = 'sync-dot ' + state;
  d.title = title;
}

function scheduleSync() {
  if (!gist.settings().token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 2500);
}

async function runSync() {
  if (!gist.settings().token) { setDot('', 'Sync is off'); return; }
  if (syncing) { syncAgain = true; return; }
  if (!navigator.onLine) { setDot('err', 'Offline: will sync when back online'); return; }
  syncing = true;
  setDot('busy', 'Syncing…');
  try {
    const merged = await gist.sync(lib);
    if (merged) {
      // Edits made while the sync was in flight are newer and win this merge;
      // if there were any, the gist doesn't have them yet, so go round again.
      const { merged: m, localChanged, remoteChanged } = core.merge(lib, merged);
      lib = m; persist();
      if (remoteChanged) syncAgain = true;
      const typing = route.name === 'settings' || document.activeElement?.id === 'notes';
      if (localChanged && !typing) render();
    }
    syncError = '';
    setDot('ok', `Synced ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    syncError = err.message;
    setDot('err', 'Sync failed: ' + err.message);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(); }
  }
}

// ---------- actions ----------

document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = route.name === 'book' ? route.args[0] : null;
  const cur = id ? entryFor(id) : null;

  if (act === 'status') {
    const status = el.dataset.status;
    if (cur) { putEntry(core.setStatus(cur, status)); render(); return; }
    el.disabled = true;
    const e = await addBook(id, status);
    if (e) { toast(`Added to ${core.STATUS_LABEL[status]}`); render(); }
    el.disabled = false;
  }
  if (act === 'quick-want') {
    ev.preventDefault();
    el.disabled = true;
    const doc = lastSearch.results.find(b => b.id === el.dataset.id);
    const e = await addBook(el.dataset.id, 'want', doc);
    if (e) { toast('Added to Want to read'); el.outerHTML = `<span class="badge want">${core.STATUS_LABEL.want}</span>`; }
    else el.disabled = false;
  }
  if (act === 'rate' && cur) {
    const r = +el.dataset.r;
    putEntry(core.update(cur, { rating: cur.rating === r ? 0 : r }));
    render();
  }
  if (act === 'read-again' && cur) { putEntry(core.readAgain(cur)); render(); }
  if (act === 'add-read' && cur) { putEntry(core.update(cur, { reads: [...cur.reads, { start: null, end: null }] })); render(); }
  if (act === 'del-read' && cur) {
    const reads = cur.reads.filter((_, i) => i !== +el.dataset.i);
    putEntry(core.update(cur, { reads }));
    render();
  }
  if (act === 'remove' && cur) {
    if (!confirm(`Remove "${cur.title}" from your library? Your rating, dates and notes for it go too.`)) return;
    putEntry(core.remove(cur));
    toast('Removed');
    render();
  }
  if (act === 'more-desc') { document.getElementById('desc')?.classList.remove('clamp'); el.remove(); }
  if (act === 'retry') render();
  if (act === 'find') {
    el.disabled = true;
    try {
      const hits = await api.search(`${el.dataset.title} ${el.dataset.author || ''}`.trim());
      const t = el.dataset.title.toLowerCase();
      const best = hits.find(h => h.title.toLowerCase() === t) || hits[0];
      if (best) location.hash = `#/book/${best.id}`;
      else toast("Open Library doesn't have that one");
    } catch { toast("Couldn't reach Open Library"); }
    el.disabled = false;
  }
  if (act === 'sync-now') { await runSync(); toast(syncError || 'Synced'); render(); }
  if (act === 'disconnect') {
    if (!confirm('Stop syncing on this device? Your books stay here.')) return;
    gist.disconnect(); setDot('', 'Sync is off'); render();
  }
  if (act === 'export') {
    const blob = new Blob([JSON.stringify(lib, null, 1)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `shelf-life-${core.today()}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
});

// ---------- start ----------

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') runSync(); });
window.addEventListener('online', runSync);
if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost') {
  navigator.serviceWorker?.register('sw.js').catch(() => {});
}
navigator.storage?.persist?.().catch(() => {});
render();
runSync();
