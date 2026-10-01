import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeZip, readZip, crc32 } from '../../app/js/zip.js';

test('crc32 known value', () => {
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
});

test('zip round trip with unicode names', async () => {
  const zip = await makeZip([{ name: 'Notes/Café ideas.md', data: '# Hi ☕' }, { name: 'a.bin', data: new Uint8Array([1, 2, 3]) }]);
  const files = await readZip(zip);
  assert.equal(files.length, 2);
  assert.equal(files[0].name, 'Notes/Café ideas.md');
  assert.equal(new TextDecoder().decode(files[0].data), '# Hi ☕');
  assert.deepEqual([...files[1].data], [1, 2, 3]);
});
