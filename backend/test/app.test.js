import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { signer, uploadInput, parseRange, AppError } from '../src/core.js';
import { Uploads } from '../src/uploads.js';

class MemoryStore {
  event = { connected: true, folderId: 'folder', uploadsOpen: true, usedBytes: 0, reservedBytes: 0, activeUploads: 0 };
  rows = new Map(); states = new Map();
  async getEvent() { return { ...this.event }; }
  async patchEvent(v) { Object.assign(this.event, v); }
  async getUpload(id) { return this.rows.has(id) ? { ...this.rows.get(id) } : null; }
  async patchUpload(id, v) { Object.assign(this.rows.get(id), v); }
  async reserve(row, config) {
    if (this.rows.has(row.id)) return this.getUpload(row.id);
    if (!this.event.uploadsOpen) throw new AppError(503, 'uploads_closed', 'Closed');
    if (this.event.usedBytes + this.event.reservedBytes + row.size > config.maxEventBytes) throw new AppError(507, 'event_full', 'Full');
    this.rows.set(row.id, { ...row }); this.event.reservedBytes += row.size; this.event.activeUploads++;
    return { ...row };
  }
  async acquire(id, lease, now) { const row = this.rows.get(id); if (!row) throw new AppError(404, 'not_found', 'Missing'); if (row.leaseUntil > now) throw new AppError(409, 'upload_busy', 'Busy', true); const copy = { ...row }; Object.assign(row, { leaseId: lease, leaseUntil: now + 180000 }); return copy; }
  async release(id, lease) { const row = this.rows.get(id); if (row.leaseId === lease) Object.assign(row, { leaseId: null, leaseUntil: 0 }); }
  async finish(id, status, extra = {}) { const row = this.rows.get(id); if (['complete', 'expired', 'cancelled', 'rejected'].includes(row.status)) return { ...row }; Object.assign(row, extra, { status }); this.event.reservedBytes -= row.size; this.event.activeUploads--; if (status === 'complete') this.event.usedBytes += row.size; return { ...row }; }
  async expired(now) { return [...this.rows.values()].filter(r => r.expiresAt < now && ['creating', 'uploading'].includes(r.status)); }
  async page(_cursor, limit, admin) { const docs = [...this.rows.values()].slice(0, limit); return { rows: docs.filter(r => r.status === 'complete' && (admin || !r.hidden)), last: docs.at(-1), hasMore: false }; }
  async rate() {}
  async putState(id, v) { this.states.set(id, v); }
  async consumeState(id, sid, now) { const value = this.states.get(id); if (!value || value.sid !== sid || value.expiresAt < now) throw new AppError(400, 'invalid_state', 'Bad state'); this.states.delete(id); return value; }
}
class MockDrive {
  files = new Map(); chunks = 0;
  async setup() { return { oauthConfigured: true, connected: true }; }
  async quota() { return { limit: '1099511627776', usage: '0' }; }
  async generateId() { return `drive-${this.files.size}-${Math.random()}`; }
  async initiate(row) { this.files.set(row.driveId, { id: row.driveId, size: 0, mimeType: row.mimeType, parents: ['folder'], parts: [] }); return { sessionUrl: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=test' }; }
  async status(row) { const file = this.files.get(row.driveId); return { offset: file.size, complete: file.size === row.size }; }
  async chunk(row, range, stream) { const parts = []; for await (const data of stream) parts.push(data); const bytes = Buffer.concat(parts); assert.equal(bytes.length, range.length); const file = this.files.get(row.driveId); file.parts.push(bytes); file.size += bytes.length; this.chunks++; return this.status(row); }
  async metadata(id) { return this.files.get(id); }
  async media(row) { return new Response(Buffer.concat(this.files.get(row.driveId).parts), { headers: { 'Content-Type': row.mimeType } }); }
  async thumbnail() { return new Response(Buffer.from('preview'), { headers: { 'Content-Type': 'image/jpeg' } }); }
  async authorizeUrl(state) { return 'https://accounts.google.com/o/oauth2/v2/auth?state=' + state; }
  async connect() {}
  async ensureFolder() { return 'folder'; }
}
const config = { publicBaseUrl: '', frontendOrigin: 'https://aaronkbutler.github.io', frontendUrl: 'https://aaronkbutler.github.io/wedding-photos/', ownerEmail: 'owner@example.com', adminKey: 'a'.repeat(40), eventKey: 'e'.repeat(40), signingKey: 's'.repeat(48), maxFileBytes: 1073741824, chunkBytes: 8388608, maxEventBytes: 107374182400, maxActiveUploads: 30, development: true };
async function fixture(t) {
  const store = new MemoryStore(), drive = new MockDrive(), conf = { ...config };
  const app = createApp({ config: conf, store, drive }); const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`; conf.publicBaseUrl = base;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const call = async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, headers: { ...options.headers } });
    return { response, data: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
  };
  const session = await call('/api/guest/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventKey: config.eventKey }) });
  return { store, drive, conf, base, call, headers: { Authorization: `Bearer ${session.data.token}` } };
}
test('access tokens enforce purpose, expiry and tampering', () => {
  let time = 100; const codec = signer(config.signingKey, () => time); const token = codec.sign({ purpose: 'guest' }, 20);
  assert.equal(codec.verify(token, 'guest').purpose, 'guest');
  assert.throws(() => codec.verify(token, 'admin')); assert.throws(() => codec.verify(token + 'x', 'guest'));
  time = 120; assert.throws(() => codec.verify(token, 'guest'));
});
test('upload metadata and chunk ranges reject dangerous or inconsistent inputs', () => {
  const input = { name: 'photo.jpg', mimeType: 'image/jpeg', size: 100, uploadKey: 'a'.repeat(20) };
  assert.equal(uploadInput(input, 1000).name, 'photo.jpg');
  for (const change of [{ name: '../photo.jpg' }, { mimeType: 'text/html' }, { size: 0 }, { size: 1001 }, { guestName: 'x'.repeat(81) }]) assert.throws(() => uploadInput({ ...input, ...change }, 1000));
  assert.equal(parseRange('bytes 0-99/100', 100, 1000).length, 100);
  for (const range of ['bytes 0-100/100', 'bytes 1-0/100', 'bytes 0-98/100', 'bytes 0-99/101']) assert.throws(() => parseRange(range, 100, 1000));
});
test('guest and owner access are separate; hostile origins cannot mint sessions', async t => {
  const { call, headers, base } = await fixture(t);
  assert.equal((await call('/api/gallery')).response.status, 401);
  assert.equal((await call('/api/admin/status', { headers })).response.status, 401);
  assert.equal((await call('/api/guest/session', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ eventKey: config.eventKey }) })).response.status, 403);
  const owner = await call('/api/admin/session', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ adminKey: config.adminKey }) });
  assert.equal(owner.response.status, 200); const cookie = owner.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/api/admin/settings', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"uploadsOpen":false}' })).response.status, 403);
  assert.equal((await call('/api/admin/settings', { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: '{"uploadsOpen":false}' })).response.status, 200);
});
test('lost upload responses reconcile without duplicate bytes; only completed files reach gallery', async t => {
  const { call, headers, drive, store } = await fixture(t); const size = 262144 + 5;
  const body = { name: 'memory.mp4', mimeType: 'video/mp4', size, guestName: 'Guest', caption: '<script>text only</script>', uploadKey: 'unique_test_upload_1234' };
  const create = () => call('/api/uploads', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const { data: row } = await create(); assert.ok(row.id); assert.equal(row.complete, false);
  assert.equal((await create()).data.id, row.id); assert.equal(store.event.activeUploads, 1);
  const uploadHeaders = { ...headers, 'X-Upload-Token': row.uploadToken, 'Content-Type': 'application/octet-stream' };
  const firstChunk = Buffer.alloc(262144, 7);
  const put = (data, range) => call('/api/uploads/' + row.id, { method: 'PUT', headers: { ...uploadHeaders, 'Content-Range': range }, body: data });
  assert.equal((await put(firstChunk, `bytes 0-262143/${size}`)).data.offset, 262144);
  assert.equal((await call('/api/gallery', { headers })).data.items.length, 0);
  // Same chunk resent after a response was lost must not write again.
  assert.equal((await put(firstChunk, `bytes 0-262143/${size}`)).data.offset, 262144); assert.equal(drive.chunks, 1);
  assert.equal((await call('/api/uploads/' + row.id, { headers: uploadHeaders })).data.offset, 262144);
  const final = await put(Buffer.from('hello'), `bytes 262144-${size - 1}/${size}`); assert.equal(final.data.complete, true);
  assert.equal(store.event.reservedBytes, 0); assert.equal(store.event.usedBytes, size); assert.equal(store.event.activeUploads, 0);
  const gallery = (await call('/api/gallery', { headers })).data; assert.equal(gallery.items.length, 1);
  const media = new URL(gallery.items[0].downloadUrl); const response = await fetch(media); assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.concat([firstChunk, Buffer.from('hello')]));
  await store.patchUpload(row.id, { hidden: true });
  assert.equal((await call('/api/gallery', { headers })).data.items.length, 0);
  assert.equal((await fetch(media)).status, 404); // Previously signed link cannot bypass hiding.
});
test('upload proofs cannot be swapped between files; malformed chunks never reach Drive', async t => {
  const { call, headers, drive } = await fixture(t);
  const create = key => call('/api/uploads', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'photo.jpg', mimeType: 'image/jpeg', size: 10, uploadKey: key }) });
  const a = (await create('a'.repeat(24))).data, b = (await create('b'.repeat(24))).data;
  assert.equal((await call('/api/uploads/' + b.id, { headers: { ...headers, 'X-Upload-Token': a.uploadToken } })).response.status, 403);
  const bad = await call('/api/uploads/' + a.id, { method: 'PUT', headers: { ...headers, 'X-Upload-Token': a.uploadToken, 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-9/11' }, body: '0123456789' });
  assert.equal(bad.response.status, 400); assert.equal(drive.chunks, 0);
});
test('cancelling releases reservation and expired sessions cannot be resumed', async () => {
  const store = new MemoryStore(), drive = new MockDrive(); let now = 100;
  const uploads = new Uploads({ store, drive, config, clock: () => now });
  const row = await uploads.create({ name: 'photo.jpg', mimeType: 'image/jpeg', size: 10, uploadKey: 'x'.repeat(24) });
  await uploads.cancel(row.id); assert.equal(store.event.reservedBytes, 0); assert.equal(store.event.activeUploads, 0);
  await assert.rejects(uploads.status(row.id), { code: 'upload_expired' });
  const other = await uploads.create({ name: 'other.jpg', mimeType: 'image/jpeg', size: 10, uploadKey: 'y'.repeat(24) });
  now += 3 * 86400000; await uploads.expire(); assert.equal((await store.getUpload(other.id)).status, 'expired'); assert.equal(store.event.reservedBytes, 0);
});
test('OAuth callback state is bound to the owner session and can only be consumed once', async t => {
  const { call, base } = await fixture(t);
  const login = async () => {
    const result = await call('/api/admin/session', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ adminKey: config.adminKey }) });
    return result.response.headers.get('set-cookie').split(';')[0];
  };
  const cookie = await login();
  const start = await call('/api/admin/oauth/start', { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
  const state = new URL(start.data.url).searchParams.get('state');
  const otherCookie = await login();
  assert.equal((await call('/api/admin/oauth/callback?code=fake&state=' + state, { headers: { Cookie: otherCookie }, redirect: 'manual' })).response.status, 400);
  assert.equal((await call('/api/admin/oauth/callback?code=fake&state=' + state, { headers: { Cookie: cookie }, redirect: 'manual' })).response.status, 302);
  assert.equal((await call('/api/admin/oauth/callback?code=fake&state=' + state, { headers: { Cookie: cookie }, redirect: 'manual' })).response.status, 400);
});
