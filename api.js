// Open Library (search, books, authors, covers) and Wikidata (series and bibliographies).
// Every lookup is cached in localStorage, so pages you've visited still open offline
// and a book page doesn't re-ask Wikidata each time.
import { bookFromDoc, groupAuthorWorks, groupSeries, seriesOfWork, cleanIsbn } from './core.js';

const OL = 'https://openlibrary.org';
const WDQS = 'https://query.wikidata.org/sparql';
const CACHE_PREFIX = 'sl_cache_';
const DAY = 86400000;
const DOC_FIELDS = 'key,title,author_name,author_key,cover_i,first_publish_year,number_of_pages_median,edition_count';

export const coverUrl = (id, size = 'M') => (id ? `https://covers.openlibrary.org/b/id/${id}-${size}.jpg` : null);
export const authorPhotoUrl = (id, size = 'M') => (id ? `https://covers.openlibrary.org/a/id/${id}-${size}.jpg` : null);

async function cached(key, maxAge, load) {
  const k = CACHE_PREFIX + key;
  let hit = null;
  try { hit = JSON.parse(localStorage.getItem(k)); } catch {}
  if (hit && Date.now() - hit.t < maxAge) return hit.v;
  try {
    const v = await load();
    try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), v })); } catch { pruneCache(); }
    return v;
  } catch (err) {
    if (hit) return hit.v; // offline or rate-limited: an old answer beats none
    throw err;
  }
}

// If storage fills up, drop the oldest half of the cache (never the library itself).
function pruneCache() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX));
  const aged = keys.map(k => { try { return [k, JSON.parse(localStorage.getItem(k)).t]; } catch { return [k, 0]; } }).sort((a, b) => a[1] - b[1]);
  aged.slice(0, Math.ceil(aged.length / 2)).forEach(([k]) => localStorage.removeItem(k));
}

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

async function sparql(query) {
  const data = await getJson(`${WDQS}?format=json&query=${encodeURIComponent(query)}`, { headers: { Accept: 'application/sparql-results+json' } });
  return data.results.bindings;
}

export async function search(q) {
  const s = q.trim();
  const isbn = cleanIsbn(s);
  const query = isbn ? `isbn:${isbn}` : s;
  const data = await getJson(`${OL}/search.json?q=${encodeURIComponent(query)}&fields=${DOC_FIELDS}&limit=30`);
  return data.docs.filter(d => d.key?.startsWith('/works/')).map(d => ({ ...bookFromDoc(d), editions: d.edition_count || 0 }));
}

// A barcode or typed ISBN → the Open Library work id, or null. Google Books fills in when
// Open Library doesn't know that edition: its title and author find the work by search.
export async function workForIsbn(isbn) {
  const hits = await search(isbn);
  if (hits.length) return hits[0].id;
  try {
    const g = await getJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
    const v = g.items?.[0]?.volumeInfo;
    if (!v) return null;
    const found = await search(`${v.title} ${(v.authors || [])[0] || ''}`);
    return found[0]?.id || null;
  } catch { return null; }
}

// Search docs for many works in one call (covers, years, authors for author and series pages).
export async function docsForWorks(ids) {
  const out = {};
  const want = [...new Set(ids.filter(Boolean))];
  const todo = [];
  for (const id of want) {
    try {
      const hit = JSON.parse(localStorage.getItem(CACHE_PREFIX + 'doc_' + id));
      if (hit && Date.now() - hit.t < 30 * DAY) { out[id] = hit.v; continue; }
    } catch {}
    todo.push(id);
  }
  for (let i = 0; i < todo.length; i += 50) {
    const chunk = todo.slice(i, i + 50);
    try {
      const q = `key:(${chunk.map(id => `/works/${id}`).join(' OR ')})`;
      const data = await getJson(`${OL}/search.json?q=${encodeURIComponent(q)}&fields=${DOC_FIELDS}&limit=50`);
      for (const d of data.docs) {
        const b = bookFromDoc(d);
        out[b.id] = b;
        try { localStorage.setItem(CACHE_PREFIX + 'doc_' + b.id, JSON.stringify({ t: Date.now(), v: b })); } catch { pruneCache(); }
      }
    } catch {}
  }
  return out;
}

export function work(id) {
  return cached('work_' + id, 30 * DAY, async () => {
    const [w, docs] = await Promise.all([getJson(`${OL}/works/${id}.json`), docsForWorks([id])]);
    const base = docs[id] || { id, title: w.title, authors: [], cover: w.covers?.find(c => c > 0) || null, pages: null, year: null };
    if (!base.authors.length && w.authors) {
      base.authors = await Promise.all(w.authors.slice(0, 3).map(async a => {
        const aid = a.author?.key?.replace('/authors/', '');
        try { return { id: aid, name: (await getJson(`${OL}/authors/${aid}.json`)).name }; } catch { return { id: aid, name: 'Unknown' }; }
      }));
    }
    const desc = typeof w.description === 'string' ? w.description : w.description?.value || '';
    return {
      ...base,
      description: tidyDescription(desc),
      subjects: (w.subjects || []).filter(s => !/[:=]|\breviewed\b|^fiction$|^general$/i.test(s) && s.length < 40).slice(0, 8),
    };
  });
}

function tidyDescription(text) {
  return text
    .replace(/\r/g, '')
    .replace(/\(\[source\]\[\d+\]\)|\[source\]\[\d+\]/g, '')
    .replace(/^\s*\[\d+\]:.*$/gm, '')
    .replace(/-{3,}[\s\S]*$/, '') // OL appends "----------\nAlso contained in:" lists
    .replace(/\*\*|__/g, '')
    .replace(/(^|[\s("'])\*([^*\n]+)\*(?=[\s.,;:!?)"'\-–—]|$)/gm, '$1$2') // *italic*
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

export function seriesForWork(id) {
  return cached('wseries_' + id, 14 * DAY, async () => seriesOfWork(await sparql(`
    SELECT ?s ?sLabel ?ord WHERE {
      ?w wdt:P648 "${id}". ?w p:P179 ?st. ?st ps:P179 ?s. OPTIONAL { ?st pq:P1545 ?ord }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }`)));
}

export function author(id) {
  return cached('author_' + id, 14 * DAY, async () => {
    const a = await getJson(`${OL}/authors/${id}.json`);
    let wd = a.remote_ids?.wikidata || null;
    if (!wd) {
      try {
        const rows = await sparql(`SELECT ?a WHERE { ?a wdt:P648 "${id}" } LIMIT 1`);
        wd = rows[0]?.a?.value.split('/').pop() || null;
      } catch {}
    }
    const bio = typeof a.bio === 'string' ? a.bio : a.bio?.value || '';
    return {
      id, wd, name: a.personal_name && a.name?.length < 4 ? a.personal_name : a.name,
      bio: tidyDescription(bio), born: a.birth_date || null, died: a.death_date || null,
      photo: (a.photos || []).find(p => p > 0) || null,
      wikipedia: a.wikipedia || (a.links || []).find(l => /wikipedia/.test(l.url))?.url || null,
    };
  });
}

// The author's bibliography grouped into series and standalone books. Wikidata when it knows
// the author (reading order, series); otherwise Open Library's work list, which has no series.
export function authorWorks(a) {
  return cached('aworks_' + a.id, 14 * DAY, async () => {
    if (a.wd) {
      const rows = await sparql(`
        SELECT ?w ?wLabel ?ol ?date ?s ?sLabel ?ord (GROUP_CONCAT(DISTINCT ?t) AS ?types)
               (GROUP_CONCAT(DISTINCT ?fl; separator="|") AS ?forms) (SAMPLE(?pub) AS ?inside) (SAMPLE(?isS) AS ?isSeries) WHERE {
          ?w wdt:P50 wd:${a.wd}; wdt:P31 ?t0.
          VALUES ?t0 { wd:Q7725634 wd:Q47461344 wd:Q571 wd:Q8261 wd:Q149537 wd:Q1279564 wd:Q49084 }
          ?w wdt:P31 ?t.
          OPTIONAL { ?w wdt:P648 ?ol }
          OPTIONAL { ?w wdt:P577 ?date }
          OPTIONAL { ?w wdt:P7937 ?f. ?f rdfs:label ?fl. FILTER(lang(?fl) = "en") }
          OPTIONAL { ?w wdt:P1433 ?pub }
          BIND(EXISTS { ?x wdt:P179 ?w } AS ?isS)
          OPTIONAL { ?w p:P179 ?st. ?st ps:P179 ?s. OPTIONAL { ?st pq:P1545 ?ord } }
          SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
        } GROUP BY ?w ?wLabel ?ol ?date ?s ?sLabel ?ord`);
      const g = groupAuthorWorks(rows);
      if (g.series.length + g.novels.length > 0) return { source: 'wikidata', ...g };
    }
    const data = await getJson(`${OL}/search.json?q=${encodeURIComponent(`author_key:${a.id}`)}&fields=${DOC_FIELDS}&sort=editions&limit=60`);
    const seen = new Set();
    const novels = data.docs.map(d => ({ ...bookFromDoc(d), editions: d.edition_count }))
      .filter(b => { const k = b.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .map(b => ({ wd: null, ol: b.id, title: b.title, year: b.year, series: [] }))
      .sort((x, y) => (x.year || 9999) - (y.year || 9999));
    return { source: 'openlibrary', series: [], novels, other: [] };
  });
}

export function series(id) {
  return cached('series_' + id, 14 * DAY, async () => {
    const rows = await sparql(`
      SELECT ?w ?wLabel ?ord ?ol ?date ?a ?aLabel ?sLabel (GROUP_CONCAT(DISTINCT ?t) AS ?types)
             (GROUP_CONCAT(DISTINCT ?fl; separator="|") AS ?forms) (SAMPLE(?isS) AS ?isSeries) WHERE {
        BIND(wd:${id} AS ?s)
        ?w p:P179 ?st. ?st ps:P179 ?s. OPTIONAL { ?st pq:P1545 ?ord }
        OPTIONAL { ?w wdt:P31 ?t }
        OPTIONAL { ?w wdt:P7937 ?f. ?f rdfs:label ?fl. FILTER(lang(?fl) = "en") }
        BIND(EXISTS { ?x wdt:P179 ?w } AS ?isS)
        OPTIONAL { ?w wdt:P648 ?ol }
        OPTIONAL { ?w wdt:P577 ?date }
        OPTIONAL { ?w wdt:P50 ?a }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      } GROUP BY ?w ?wLabel ?ord ?ol ?date ?a ?aLabel ?sLabel`);
    return { id, ...groupSeries(rows) };
  });
}

export function cachedSeries(id) {
  try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + 'series_' + id))?.v || null; } catch { return null; }
}
