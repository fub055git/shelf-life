// Pure logic for Shelf Life: the library model, merging two copies of it (device + gist),
// shaping Wikidata results into author and series pages, ISBN checks and reading stats.
// No DOM and no network here, so tests/core.test.js can run all of it under node.

export const STATUSES = ['reading', 'want', 'read', 'dropped'];
export const STATUS_LABEL = { want: 'Want to read', reading: 'Reading', read: 'Read', dropped: 'Dropped' };

// Deleted books stay as tombstones so a delete on one device wins over an older copy on another.
// After this long every device has synced, so they can go.
const TOMBSTONE_MS = 180 * 24 * 3600 * 1000;

export function emptyLibrary() {
  return { v: 1, books: {} };
}

export function today(now = new Date()) {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}

// The fields copied from an Open Library search doc onto a library entry.
export function bookFromDoc(doc) {
  return {
    id: String(doc.key || '').replace('/works/', ''),
    title: doc.title || 'Untitled',
    authors: (doc.author_name || []).map((name, i) => ({ id: (doc.author_key || [])[i] || null, name })),
    cover: doc.cover_i || null,
    pages: doc.number_of_pages_median || null,
    year: doc.first_publish_year || null,
  };
}

export function newEntry(meta, status, now = Date.now()) {
  const e = {
    id: meta.id, title: meta.title, authors: meta.authors || [], cover: meta.cover ?? null,
    pages: meta.pages ?? null, year: meta.year ?? null, series: meta.series || [],
    status: 'want', rating: 0, reads: [], notes: '', added: today(new Date(now)), updated: now,
  };
  return setStatus(e, status, now);
}

// Changing status keeps the reading dates in step: starting a book opens a read,
// finishing closes it (or records one with only an end date if it was never started here).
export function setStatus(entry, status, now = Date.now()) {
  const e = { ...entry, reads: entry.reads.map(r => ({ ...r })), status, updated: now };
  const date = today(new Date(now));
  const open = e.reads.find(r => !r.end);
  if (status === 'reading' && !open) e.reads.push({ start: date, end: null });
  if (status === 'read') {
    if (open) open.end = date;
    else if (entry.status !== 'read') e.reads.push({ start: null, end: date });
  }
  if (status === 'want' && open && !open.start) e.reads = e.reads.filter(r => r !== open);
  return e;
}

export function readAgain(entry, now = Date.now()) {
  return { ...entry, status: 'reading', reads: [...entry.reads, { start: today(new Date(now)), end: null }], updated: now };
}

export function update(entry, fields, now = Date.now()) {
  return { ...entry, ...fields, updated: now };
}

export function remove(entry, now = Date.now()) {
  return { id: entry.id, deleted: true, updated: now };
}

// Merge two libraries book by book: the copy edited last wins. Returns the merged library and
// whether it differs from each side, so the caller knows whether to save locally and/or upload.
export function merge(local, remote, now = Date.now()) {
  const books = {};
  const ids = new Set([...Object.keys(local.books || {}), ...Object.keys(remote.books || {})]);
  for (const id of ids) {
    const a = local.books?.[id], b = remote.books?.[id];
    const pick = !a ? b : !b ? a : (b.updated > a.updated ? b : a);
    if (pick.deleted && now - pick.updated > TOMBSTONE_MS) continue;
    books[id] = pick;
  }
  const merged = { v: 1, books };
  return { merged, localChanged: !sameBooks(merged, local), remoteChanged: !sameBooks(merged, remote) };
}

function sameBooks(a, b) {
  const ka = Object.keys(a.books || {}), kb = Object.keys(b.books || {});
  if (ka.length !== kb.length) return false;
  return ka.every(k => b.books[k] && b.books[k].updated === a.books[k].updated && !!b.books[k].deleted === !!a.books[k].deleted);
}

export function liveBooks(lib) {
  return Object.values(lib.books).filter(b => !b.deleted);
}

export function lastRead(entry) {
  return entry.reads.filter(r => r.end).map(r => r.end).sort().pop() || null;
}

const SORTS = {
  added: (a, b) => (b.added || '').localeCompare(a.added || '') || b.updated - a.updated,
  finished: (a, b) => (lastRead(b) || '').localeCompare(lastRead(a) || '') || b.updated - a.updated,
  title: (a, b) => sortTitle(a.title).localeCompare(sortTitle(b.title)),
  author: (a, b) => authorSurname(a).localeCompare(authorSurname(b)) || seriesKey(a).localeCompare(seriesKey(b)) || sortTitle(a.title).localeCompare(sortTitle(b.title)),
  rating: (a, b) => b.rating - a.rating || sortTitle(a.title).localeCompare(sortTitle(b.title)),
};
export const SORT_LABEL = { added: 'Date added', finished: 'Date finished', title: 'Title', author: 'Author', rating: 'Rating' };

export function shelf(lib, status, sort = status === 'read' ? 'finished' : 'added', filter = '') {
  const q = filter.trim().toLowerCase();
  return liveBooks(lib)
    .filter(b => b.status === status)
    .filter(b => !q || b.title.toLowerCase().includes(q) || b.authors.some(a => a.name.toLowerCase().includes(q)))
    .sort(SORTS[sort] || SORTS.added);
}

function sortTitle(t) {
  return (t || '').replace(/^(the|a|an)\s+/i, '').toLowerCase();
}
function authorSurname(b) {
  const n = b.authors[0]?.name || '';
  return n.split(/\s+/).pop().toLowerCase();
}
function seriesKey(b) {
  const s = b.series?.[0];
  return s ? `${s.name}|${String(ordinal(s.pos)).padStart(6, '0')}` : '~';
}

// Wikidata series ordinals are strings: "1", "0", "2.5", sometimes "4a" or missing.
export function ordinal(pos) {
  const n = parseFloat(pos);
  return Number.isFinite(n) ? n : 9999;
}

// ---------- ISBN ----------

export function cleanIsbn(text) {
  const s = String(text || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (s.length === 13 && /^\d{13}$/.test(s)) {
    const sum = [...s].reduce((t, c, i) => t + Number(c) * (i % 2 ? 3 : 1), 0);
    return sum % 10 === 0 ? s : null;
  }
  if (s.length === 10 && /^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((t, c, i) => t + (c === 'X' ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0 ? s : null;
  }
  return null;
}

// A scanned barcode on a book is EAN-13 starting 978/979; anything else (price add-ons, store codes) isn't an ISBN.
export function isBookBarcode(code) {
  const s = cleanIsbn(code);
  return !!s && s.length === 13 && /^97[89]/.test(s);
}

// ---------- Wikidata ----------

const WD = 'http://www.wikidata.org/entity/';
const qid = uri => (uri || '').replace(WD, '');
const year = d => (d ? Number(String(d).slice(0, 4)) || null : null);
const hasLabel = (label, id) => label && label !== id && !/^Q\d+$/.test(label);

// Editions and translations sometimes carry the author too; they duplicate the work.
export const EDITION_TYPES = new Set(['Q3331189', 'Q53731850']);
// Items that are themselves series (Discworld's "Witches", "Rincewind"): shown as sub-series, not books.
export const SERIES_TYPES = new Set(['Q277759', 'Q1667921', 'Q7725310', 'Q13593966', 'Q47068459']);
// Wikidata's "form of creative work" for things you wouldn't shelve as a book of their own.
const SHORT_FORM = /short story$|^short story$|novelette|anthology|poem|essay|comic|article|play$|^story$/i;

// Many rows per work (one per type × series × OL id × date): fold them into one record each.
function collect(bindings) {
  const works = new Map();
  for (const b of bindings) {
    const id = qid(b.w?.value);
    if (!id) continue;
    const w = works.get(id) || { wd: id, title: b.wLabel?.value, ol: null, olEdition: false, year: null, pos: null, types: new Set(), forms: new Set(), inside: false, isSeries: false, series: [], authors: [] };
    const ol = b.ol?.value;
    if (ol && /W$/.test(ol) && !w.ol) w.ol = ol;
    if (ol && /M$/.test(ol)) w.olEdition = true;
    const y = year(b.date?.value);
    if (y && (!w.year || y < w.year)) w.year = y;
    for (const t of (b.types?.value || '').split(' ')) if (t) w.types.add(qid(t));
    for (const f of (b.forms?.value || '').split('|')) if (f) w.forms.add(f);
    if (b.inside?.value) w.inside = true;
    if (b.isSeries?.value === 'true') w.isSeries = true;
    if (w.pos == null && b.ord?.value != null) w.pos = b.ord.value;
    const sid = qid(b.s?.value);
    if (sid && hasLabel(b.sLabel?.value, sid) && !w.series.some(s => s.id === sid)) w.series.push({ id: sid, name: b.sLabel.value, pos: b.ord?.value ?? null });
    const an = b.aLabel?.value;
    if (an && hasLabel(an, qid(b.a?.value)) && !w.authors.includes(an)) w.authors.push(an);
    works.set(id, w);
  }
  return [...works.values()].filter(w => hasLabel(w.title, w.wd));
}

const isSeriesItem = w => w.isSeries || [...w.types].some(t => SERIES_TYPES.has(t));
// An edition record: typed as one, or linked only to an Open Library edition and with no form of its own.
const isEdition = w => [...w.types].some(t => EDITION_TYPES.has(t)) || (w.olEdition && !w.ol && !w.forms.size);
const isShort = w => [...w.forms].some(f => SHORT_FORM.test(f)) || (w.inside && ![...w.forms].some(f => /novel/i.test(f)));

// Rows from an author query into { series: [{id, name, books}], novels: [...], other: [...] },
// books in reading order. "other" is short fiction and the like.
export function groupAuthorWorks(bindings) {
  const list = collect(bindings).filter(w => !isSeriesItem(w) && !isEdition(w));
  const seriesMap = new Map();
  const novels = [], other = [];
  for (const w of list) {
    const book = { wd: w.wd, title: w.title, ol: w.ol, year: w.year, series: w.series };
    if (isShort(w)) other.push(book);
    else if (w.series.length) {
      for (const s of w.series) {
        const g = seriesMap.get(s.id) || { id: s.id, name: s.name, books: [] };
        g.books.push({ ...book, pos: s.pos });
        seriesMap.set(s.id, g);
      }
    } else novels.push(book);
  }
  const byPos = (a, b) => ordinal(a.pos) - ordinal(b.pos) || (a.year || 9999) - (b.year || 9999);
  const byYear = (a, b) => (a.year || 9999) - (b.year || 9999) || a.title.localeCompare(b.title);
  const series = [...seriesMap.values()].map(s => ({ ...s, books: s.books.sort(byPos), start: Math.min(...s.books.map(b => b.year || 9999)) }));
  // Anthology "series" (Best American…) only hold one or two of this author's entries; list big series first.
  series.sort((a, b) => b.books.length - a.books.length || a.start - b.start);
  return { series, novels: novels.sort(byYear), other: other.sort(byYear) };
}

// Rows from a series query into its books in reading order (each with its authors),
// plus any sub-series. Unnumbered books (companions, guides) sort last.
export function groupSeries(bindings) {
  const name = bindings.find(b => b.sLabel?.value)?.sLabel.value || null;
  const all = collect(bindings).filter(w => !isEdition(w));
  const tidy = ({ wd, title, ol, year, pos, authors }) => ({ wd, title, ol, year, pos, authors });
  const books = all.filter(w => !isSeriesItem(w)).map(tidy)
    .sort((a, b) => ordinal(a.pos) - ordinal(b.pos) || (a.year || 9999) - (b.year || 9999) || a.title.localeCompare(b.title));
  const subseries = all.filter(isSeriesItem).map(w => ({ id: w.wd, name: w.title })).sort((a, b) => a.name.localeCompare(b.name));
  return { name, books, subseries };
}

// Rows from a lookup by Open Library work id into the series that work belongs to.
export function seriesOfWork(bindings) {
  const out = [];
  for (const b of bindings) {
    const id = qid(b.s?.value);
    if (id && hasLabel(b.sLabel?.value, id) && !out.some(s => s.id === id)) out.push({ id, name: b.sLabel.value, pos: b.ord?.value ?? null });
  }
  return out;
}

// For a series page or author page: the first book in order you haven't read, after at least one you have.
export function nextInSeries(all, lib) {
  // Companion books with no number aren't "next" in a reading order
  const books = all.some(b => b.pos != null) ? all.filter(b => b.pos != null) : all;
  const status = b => (b.ol && lib.books[b.ol] && !lib.books[b.ol].deleted ? lib.books[b.ol].status : null);
  const readIdx = books.map((b, i) => (status(b) === 'read' ? i : -1)).filter(i => i >= 0);
  if (!readIdx.length) return null;
  const next = books.find((b, i) => i > Math.min(...readIdx) && !['read', 'reading', 'dropped'].includes(status(b)));
  return next || null;
}

// ---------- Stats ----------

export function stats(lib) {
  const books = liveBooks(lib);
  const years = {};
  for (const b of books) {
    for (const r of b.reads) {
      if (!r.end) continue;
      const y = r.end.slice(0, 4);
      years[y] = years[y] || { year: y, books: 0, pages: 0 };
      years[y].books += 1;
      years[y].pages += b.pages || 0;
    }
  }
  const read = books.filter(b => b.status === 'read');
  const rated = read.filter(b => b.rating > 0);
  const authors = {};
  for (const b of read) for (const a of b.authors) {
    const k = a.id || a.name;
    authors[k] = authors[k] || { id: a.id, name: a.name, count: 0 };
    authors[k].count += 1;
  }
  const ratings = [5, 4, 3, 2, 1].map(r => ({ rating: r, count: rated.filter(b => Math.round(b.rating) === r).length }));
  return {
    total: read.length,
    pages: read.reduce((t, b) => t + (b.pages || 0), 0),
    want: books.filter(b => b.status === 'want').length,
    reading: books.filter(b => b.status === 'reading').length,
    average: rated.length ? rated.reduce((t, b) => t + b.rating, 0) / rated.length : null,
    years: Object.values(years).sort((a, b) => b.year.localeCompare(a.year)),
    ratings,
    authors: Object.values(authors).sort((a, b) => b.count - a.count).slice(0, 10),
  };
}

// ---------- Import ----------

export function parseBackup(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || !data.books || typeof data.books !== 'object') throw new Error('Not a Shelf Life backup');
  for (const [id, b] of Object.entries(data.books)) {
    if (!b || b.id !== id || typeof b.updated !== 'number') throw new Error(`Bad entry: ${id}`);
    if (!b.deleted && (!STATUSES.includes(b.status) || !Array.isArray(b.reads))) throw new Error(`Bad entry: ${id}`);
  }
  return { v: 1, books: data.books };
}
