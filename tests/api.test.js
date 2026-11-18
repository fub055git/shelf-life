import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webUrl } from '../api.js';

test('only ordinary web links from Open Library are used as links', () => {
  assert.equal(webUrl('https://en.wikipedia.org/wiki/N._K._Jemisin'), 'https://en.wikipedia.org/wiki/N._K._Jemisin');
  assert.equal(webUrl('javascript:alert(1)'), null);
  assert.equal(webUrl(' JavaScript:alert(1)'), null);
  assert.equal(webUrl('data:text/html,hi'), null);
  assert.equal(webUrl(undefined), null);
  assert.equal(webUrl('not a url'), null);
});
