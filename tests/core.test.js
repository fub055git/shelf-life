import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../core.js';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const DAY = 86400000;
const T0 = Date.UTC(2026, 10, 18, 2); // 18 Nov 2026, midday in Queensland
const meta = { id: 'OL1W', title: 'The Fifth Season', authors: [{ id: 'OL6575473A', name: 'N. K. Jemisin' }], cover: 1, pages: 505, year: 2015 };

test('starting and finishing a book records the dates', () => {
  let e = core.newEntry(meta, 'reading', T0);
  assert.equal(e.reads.length, 1);
  assert.equal(e.reads[0].end, null);
  e = core.setStatus(e, 'read', T0 + 5 * DAY);
  assert.equal(e.reads.length, 1);
  assert.ok(e.reads[0].start < e.reads[0].end);
});

test('marking a book read without starting it records just the finish date', () => {
  const e = core.newEntry(meta, 'read', T0);
  assert.deepEqual(e.reads.map(r => r.start), [null]);
  assert.ok(e.reads[0].end);
  // pressing Read again on a read book doesn't add another read
  assert.equal(core.setStatus(e, 'read', T0 + DAY).reads.length, 1);
});

test('want-to-read books have no reading dates', () => {
  assert.deepEqual(core.newEntry(meta, 'want', T0).reads, []);
});

test('a mis-tap on Reading undone with Want to read leaves no dates behind', () => {
  let e = core.setStatus(core.newEntry(meta, 'want', T0), 'reading', T0);
  e = core.setStatus(e, 'want', T0 + DAY);
  assert.deepEqual(e.reads, []);
  e = core.setStatus(e, 'read', T0 + 200 * DAY);
  assert.deepEqual(e.reads.map(r => r.start), [null]); // not the old mis-tap date
});

test('picking a dropped book up again starts a fresh read', () => {
  let e = core.setStatus(core.newEntry(meta, 'reading', T0), 'dropped', T0 + DAY);
  e = core.setStatus(e, 'reading', T0 + 100 * DAY);
  assert.equal(e.reads.length, 1);
  assert.equal(e.reads[0].start, core.today(new Date(T0 + 100 * DAY)));
});

test('a blank dates row gets the start date when the book is started', () => {
  const e = core.setStatus({ ...core.newEntry(meta, 'want', T0), reads: [{ start: null, end: null }] }, 'reading', T0);
  assert.equal(e.reads.length, 1);
  assert.equal(e.reads[0].start, core.today(new Date(T0)));
});

test('read again opens a second read and keeps the first', () => {
  const e = core.readAgain(core.newEntry(meta, 'read', T0), T0 + 400 * DAY);
  assert.equal(e.status, 'reading');
  assert.equal(e.reads.length, 2);
  assert.equal(e.reads[1].end, null);
});

test('merge keeps the copy edited last, book by book', () => {
  const a = core.newEntry({ ...meta, id: 'A' }, 'want', T0);
  const b = core.newEntry({ ...meta, id: 'B' }, 'want', T0);
  const phone = { v: 1, books: { A: core.update(a, { rating: 5 }, T0 + 10), B: b } };
  const pc = { v: 1, books: { A: a, B: core.setStatus(b, 'reading', T0 + 20) } };
  const { merged, localChanged, remoteChanged } = core.merge(phone, pc, T0 + 30);
  assert.equal(merged.books.A.rating, 5);
  assert.equal(merged.books.B.status, 'reading');
  assert.ok(localChanged && remoteChanged);
});

test('a delete on one device beats an older edit on another', () => {
  const a = core.newEntry({ ...meta, id: 'A' }, 'read', T0);
  const { merged } = core.merge({ v: 1, books: { A: core.remove(a, T0 + 10) } }, { v: 1, books: { A: a } }, T0 + 20);
  assert.ok(merged.books.A.deleted);
  assert.equal(core.liveBooks(merged).length, 0);
});

test('old tombstones are dropped once every device has had time to sync', () => {
  const gone = core.remove(core.newEntry(meta, 'read', T0), T0);
  const { merged } = core.merge({ v: 1, books: { OL1W: gone } }, core.emptyLibrary(), T0 + 200 * DAY);
  assert.deepEqual(merged.books, {});
});

test('merging identical libraries reports no change either way', () => {
  const lib = { v: 1, books: { OL1W: core.newEntry(meta, 'read', T0) } };
  const r = core.merge(lib, JSON.parse(JSON.stringify(lib)));
  assert.equal(r.localChanged, false);
  assert.equal(r.remoteChanged, false);
});

test('shelves filter by status and text, and sort by surname then series order', () => {
  const mk = (id, title, author, status, series) => core.newEntry({ ...meta, id, title, authors: [{ id, name: author }], series }, status, T0);
  const lib = { v: 1, books: {
    a: mk('a', 'The Stone Sky', 'N. K. Jemisin', 'read', [{ id: 'S', name: 'The Broken Earth', pos: '3' }]),
    b: mk('b', 'The Fifth Season', 'N. K. Jemisin', 'read', [{ id: 'S', name: 'The Broken Earth', pos: '1' }]),
    c: mk('c', 'Ancillary Justice', 'Ann Leckie', 'read', []),
    d: mk('d', 'Mort', 'Terry Pratchett', 'want', []),
  } };
  assert.deepEqual(core.shelf(lib, 'read', 'author').map(b => b.id), ['b', 'a', 'c']);
  assert.deepEqual(core.shelf(lib, 'read', 'title').map(b => b.id), ['c', 'b', 'a']); // "The" ignored
  assert.deepEqual(core.shelf(lib, 'read', 'added', 'leckie').map(b => b.id), ['c']);
  assert.deepEqual(core.shelf(lib, 'want').map(b => b.id), ['d']);
});

test('author sort puts series numbers in numeric order, including halves and double digits', () => {
  const mk = (id, pos) => core.newEntry({ ...meta, id, title: id, series: [{ id: 'S', name: 'Discworld', pos }] }, 'read', T0);
  const lib = { v: 1, books: { a: mk('a', '2'), b: mk('b', '1.5'), c: mk('c', '10'), d: mk('d', '9'), e: core.newEntry({ ...meta, id: 'e', title: 'Aaa' }, 'read', T0) } };
  assert.deepEqual(core.shelf(lib, 'read', 'author').map(b => b.id), ['b', 'a', 'd', 'c', 'e']);
});

test('ISBN checks: valid 13 and 10 digit, typo rejected, barcode must be 978/979', () => {
  assert.equal(core.cleanIsbn('978-0-316-22929-6'), '9780316229296');
  assert.equal(core.cleanIsbn('0316229296'), '0316229296');
  assert.equal(core.cleanIsbn('080442957X'), '080442957X');
  assert.equal(core.cleanIsbn('9780316229297'), null);
  assert.equal(core.isBookBarcode('9780316229296'), true);
  assert.equal(core.isBookBarcode('9300633603591'), false); // a grocery barcode with a valid check digit
});

test('author page: Jemisin series in order, short stories set aside, no editions or series items', () => {
  const g = core.groupAuthorWorks(fixture('author-jemisin'));
  const broken = g.series.find(s => s.name === 'The Broken Earth');
  assert.deepEqual(broken.books.map(b => b.title), ['The Fifth Season', 'The Obelisk Gate', 'The Stone Sky']);
  assert.ok(broken.books.every(b => /^OL\d+W$/.test(b.ol)));
  assert.ok(g.series.some(s => s.name === 'The Inheritance Trilogy' && s.books.length === 3));
  const all = [...g.series.flatMap(s => s.books), ...g.novels].map(b => b.title);
  assert.ok(!all.includes('The Narcomancer'), 'short story listed as a book');
  assert.ok(!all.includes('The Broken Earth'), 'the series itself listed as a book');
  assert.ok(!all.includes('La quinta estación'), 'a translation listed as a book');
  assert.ok(g.other.some(b => b.title === 'The Narcomancer'));
  assert.ok(g.novels.some(b => b.title === 'The Awakened Kingdom'));
});

test('series page: Discworld numbered 1–41, companions after, sub-series split out', () => {
  const s = core.groupSeries(fixture('series-discworld'));
  assert.equal(s.name, 'Discworld');
  const numbered = s.books.filter(b => b.pos != null);
  assert.equal(numbered[0].title, 'The Colour of Magic');
  assert.equal(numbered.at(-1).title, "The Shepherd's Crown");
  assert.ok(numbered.every((b, i) => i === 0 || core.ordinal(b.pos) >= core.ordinal(numbered[i - 1].pos)));
  assert.ok(s.books.findIndex(b => b.pos == null) > s.books.findIndex(b => b.title === "The Shepherd's Crown"));
  assert.ok(s.subseries.some(x => x.name === 'Witches'));
  assert.ok(!s.books.some(b => b.title === 'Witches'));
  assert.deepEqual(numbered[0].authors, ['Terry Pratchett']);
});

test('next in series is the first unread book after one you have read, skipping companions', () => {
  const books = [
    { ol: 'W1', pos: '1' }, { ol: 'W2', pos: '2' }, { ol: 'W3', pos: '3' }, { ol: 'C', pos: null },
  ];
  const lib = { v: 1, books: { W1: { id: 'W1', status: 'read', reads: [] } } };
  assert.equal(core.nextInSeries(books, lib).ol, 'W2');
  lib.books.W2 = { id: 'W2', status: 'reading', reads: [] };
  assert.equal(core.nextInSeries(books, lib).ol, 'W3');
  lib.books.W3 = { id: 'W3', status: 'read', reads: [] };
  assert.equal(core.nextInSeries(books, lib), null); // the companion isn't "next"
  assert.equal(core.nextInSeries(books, core.emptyLibrary()), null); // series not started
});

test('stats count re-reads in the year finished and rate only rated books', () => {
  let e = core.newEntry(meta, 'read', Date.UTC(2025, 5, 1));
  e = core.setStatus(core.readAgain(e, Date.UTC(2026, 2, 1)), 'read', Date.UTC(2026, 2, 20));
  e = core.update(e, { rating: 4 });
  const other = core.newEntry({ ...meta, id: 'OL2W', pages: 100 }, 'read', Date.UTC(2026, 3, 1));
  const st = core.stats({ v: 1, books: { [e.id]: e, OL2W: other } });
  assert.deepEqual(st.years.map(y => [y.year, y.books]), [['2026', 2], ['2025', 1]]);
  assert.equal(st.total, 2);
  assert.equal(st.average, 4);
  assert.equal(st.authors[0].count, 2);
});

test('backup import rejects files that are not a library', () => {
  assert.throws(() => core.parseBackup('{"hello":1}'));
  assert.throws(() => core.parseBackup(JSON.stringify({ books: { X: { id: 'Y', updated: 1, status: 'read', reads: [] } } })));
  const lib = { v: 1, books: { OL1W: core.newEntry(meta, 'read', T0) } };
  assert.deepEqual(core.parseBackup(JSON.stringify(lib)), lib);
});
