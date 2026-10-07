import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { GoogleDrive } from '../src/drive.js';

test('resumable requests expose Drive 308 progress without following redirects', async t => {
  let receivedBytes = 0, followed = false;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/must-not-follow') { followed = true; res.end(); return; }
    for await (const chunk of req) receivedBytes += chunk.length;
    if (req.url === '/status') res.writeHead(308);
    else res.writeHead(308, { Range: 'bytes=0-262143', Location: '/must-not-follow' });
    res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const drive = new GoogleDrive({}, {});
  drive.token = async () => 'test-access-token';
  // Production still restricts sessions to Google's HTTPS upload endpoint.
  drive.validSession = url => url === base + '/status' || url === base + '/chunk';
  const row = { sessionUrl: base + '/status', size: 524288, mimeType: 'video/mp4' };
  assert.deepEqual(await drive.status(row), { offset: 0, complete: false });
  row.sessionUrl = base + '/chunk';
  const range = { start: 0, end: 262143, length: 262144, total: row.size };
  assert.deepEqual(await drive.chunk(row, range, Readable.from(Buffer.alloc(range.length))),
    { offset: range.length, complete: false });
  assert.equal(receivedBytes, range.length);
  assert.equal(followed, false);
});
