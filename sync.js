// Sync between devices through one secret GitHub gist holding the library as JSON.
// Each device stores a GitHub token with only the "gist" permission. The first device creates
// the gist; the others find it by its file name, so setting up a new device is just the token.
import { merge, emptyLibrary } from './core.js';

const API = 'https://api.github.com';
const FILE = 'shelf-life-library.json';
const KEY = 'sl_sync';

export function settings() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
export function saveSettings(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
}
export function disconnect() {
  localStorage.removeItem(KEY);
}

async function gh(path, token, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    cache: 'no-store',
  });
  if (res.status === 401) throw new Error('GitHub refused the token. Check it has the gist permission and hasn\'t expired.');
  if (res.status === 404) throw Object.assign(new Error('Gist not found'), { notFound: true });
  if (!res.ok) throw new Error(`GitHub said ${res.status}`);
  return res.json();
}

async function findGist(token) {
  for (let page = 1; page <= 10; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`, token);
    const hit = list.find(g => g.files && g.files[FILE]);
    if (hit) return hit.id;
    if (list.length < 100) return null;
  }
  return null;
}

async function readGist(id, token) {
  const g = await gh(`/gists/${id}`, token);
  const f = g.files[FILE];
  if (!f) return emptyLibrary();
  let text = f.content;
  if (f.truncated) text = await (await fetch(f.raw_url, { cache: 'no-store' })).text();
  try { return JSON.parse(text); } catch { return emptyLibrary(); }
}

function writeGist(id, token, lib) {
  return gh(`/gists/${id}`, token, { method: 'PATCH', body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(lib) } } }) });
}

// Connect this device: find the gist made by another device, or make one. Returns the gist id.
export async function connect(token) {
  let id = await findGist(token);
  if (!id) {
    const g = await gh('/gists', token, {
      method: 'POST',
      body: JSON.stringify({ description: 'Shelf Life library (synced by the app; edit there, not here)', public: false, files: { [FILE]: { content: JSON.stringify(emptyLibrary()) } } }),
    });
    id = g.id;
  }
  saveSettings({ token, gist: id, last: null });
  return id;
}

// Pull, merge, push. Returns the merged library (or null when sync isn't set up).
export async function sync(local) {
  const s = settings();
  if (!s.token) return null;
  if (!s.gist) s.gist = await connect(s.token);
  let remote;
  try {
    remote = await readGist(s.gist, s.token);
  } catch (err) {
    if (!err.notFound) throw err;
    s.gist = await connect(s.token); // gist was deleted on GitHub: find or make another
    remote = await readGist(s.gist, s.token);
  }
  const { merged, remoteChanged } = merge(local, remote);
  if (remoteChanged) await writeGist(s.gist, s.token, merged);
  saveSettings({ ...settings(), gist: s.gist, last: Date.now() });
  return merged;
}
