# Shelf Life

A personal book tracker: what I've read, what I'm reading, what I want to read, with author and series pages. A PWA for iPhone, Mac and PC. Plain HTML/CSS/JS with no build step.

## Where the data comes from

- **Open Library** (`openlibrary.org`): search, ISBN lookup, covers, author bios and photos. Free, no key.
- **Wikidata** (`query.wikidata.org`): series membership, reading order, and author bibliographies (separating novels from short fiction via "form of creative work", P7937). Works are linked to Open Library by P648.
- **Google Books**: only as a fallback when Open Library doesn't know a scanned ISBN.

Everything fetched is cached in localStorage (`sl_cache_*`), for 14–30 days, so visited pages open offline. Covers are cached by the service worker (`shelf-life-covers`, capped at 1500).

## Data and sync

- The library is in localStorage under `sl_library`: `{ v: 1, books: { [OL work id]: entry } }`. Each entry has an `updated` time; deletes are tombstones kept for 180 days.
- Sync (optional) keeps one secret gist, `shelf-life-library.json`, on the user's GitHub account. Each device stores a classic token with only the `gist` scope (`sl_sync`). The first device creates the gist; the others find it by file name. Merging is per book, and the copy edited last wins (`core.merge`).
- Settings → Download backup / Load backup does a JSON export and a merge-import.

## Files

| File | What it does |
|---|---|
| `core.js` | Pure logic: entries, status/dates, merge, shelves/sorting, ISBN checks, Wikidata grouping, stats. Fully tested. |
| `api.js` | Open Library + Wikidata fetches and the cache. The SPARQL queries live here. |
| `sync.js` | GitHub gist sync. |
| `app.js` | Hash router and every page: shelves, search, scan, book, author, series, stats, sync. |
| `sw.js` | Offline app shell + cover cache. On each open it re-downloads all app files and swaps them in together only if every one arrived, so modules never mix versions. Add new files to `APP`. |
| `vendor/zxing.min.js` | `@zxing/library` 0.23.0 UMD, for barcode scanning on Safari (iPhone/Mac have no native `BarcodeDetector`). Loaded only on the Scan page. |
| `tools/make-icons.mjs` | Draws the PNG icons (iPhone needs PNG). `npm run icons`. |

## Run and test

```
npm test                      # core + sync tests (node:test, no installs)
npx serve -l 5340 .           # or the "books" config in code/.claude/launch.json
```

The camera needs HTTPS (or localhost). The service worker serves cached files first and swaps in new ones in the background, so reload twice to see an edit, or unregister it in dev tools.

Test fixtures in `tests/fixtures/` are real Wikidata answers (N. K. Jemisin's works, the Discworld series) saved 18 Nov 2026.
