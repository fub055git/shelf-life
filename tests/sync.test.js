// Runs the real sync.js for two devices against an in-memory stand-in for GitHub's gist API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../core.js';

const gists = new Map();
let nextId = 1;
let calls = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method || 'GET';
  calls.push(`${method} ${u.pathname}`);
  if (opts.headers?.Authorization !== 'Bearer good-token') return res(401, {});
  const json = opts.body ? JSON.parse(opts.body) : null;
  if (u.pathname === '/gists' && method === 'GET') return res(200, [...gists.values()].map(g => ({ id: g.id, files: Object.fromEntries(Object.keys(g.files).map(k => [k, {}])) })));
  if (u.pathname === '/gists' && method === 'POST') {
    const g = { id: `g${nextId++}`, files: {} };
    for (const [k, f] of Object.entries(json.files)) g.files[k] = { content: f.content };
    gists.set(g.id, g);
    return res(201, g);
  }
  const g = gists.get(u.pathname.split('/')[2]);
  if (!g) return res(404, {});
  if (method === 'PATCH') for (const [k, f] of Object.entries(json.files)) g.files[k] = { content: f.content };
  return res(200, { id: g.id, files: Object.fromEntries(Object.entries(g.files).map(([k, f]) => [k, { content: f.content, truncated: false }])) });
};
const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

// Each device has its own localStorage
function device() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
const pc = device(), phone = device();
const sync = await import('../sync.js');
const on = d => { globalThis.localStorage = d; };

const book = (id, status, t) => core.newEntry({ id, title: id, authors: [] }, status, t);

test('first device creates one private gist; second finds it with just the token', async () => {
  on(pc);
  const id = await sync.connect('good-token');
  on(phone);
  assert.equal(await sync.connect('good-token'), id);
  assert.equal(gists.size, 1);
});

test('books added on each device end up on both', async () => {
  on(pc);
  let pcLib = { v: 1, books: { A: book('A', 'read', 1000) } };
  pcLib = await sync.sync(pcLib);
  on(phone);
  let phoneLib = { v: 1, books: { B: book('B', 'want', 2000) } };
  phoneLib = await sync.sync(phoneLib);
  assert.deepEqual(Object.keys(phoneLib.books).sort(), ['A', 'B']);
  on(pc);
  pcLib = await sync.sync(pcLib);
  assert.deepEqual(Object.keys(pcLib.books).sort(), ['A', 'B']);
});

test('nothing is uploaded when nothing changed', async () => {
  on(pc);
  const lib = await sync.sync(core.emptyLibrary());
  calls = [];
  await sync.sync(lib);
  assert.ok(!calls.some(c => c.startsWith('PATCH')), calls.join(', '));
});

test('a bad token gives a plain-English error', async () => {
  on(device());
  await assert.rejects(sync.connect('bad'), /refused the token/);
});

test('if the gist was deleted on GitHub, sync makes a new one and keeps the books', async () => {
  on(pc);
  gists.clear();
  const lib = await sync.sync({ v: 1, books: { A: book('A', 'read', 1000) } });
  assert.equal(gists.size, 1);
  assert.ok(lib.books.A);
});
