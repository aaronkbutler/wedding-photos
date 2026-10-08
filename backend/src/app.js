import express from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, fail, equal, signer, nonce, digest } from './core.js';
import { Uploads } from './uploads.js';
import { adminPage } from './admin.js';

const HOUR = 3600000;
export function createApp({ config, store, drive, clock = Date.now }) {
  const app = express(); const tokens = signer(config.signingKey, clock);
  const uploads = new Uploads({ config, store, drive, clock });
  app.disable('x-powered-by'); app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    const origin = req.headers.origin;
    const allowed = origin === config.frontendOrigin || origin === config.publicBaseUrl ||
      (config.development && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin || ''));
    if (origin && !allowed) return next(new AppError(403, 'origin_denied', 'This website is not allowed to use the album.'));
    if (allowed) res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,Content-Range,X-Upload-Token', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  const ipKey = req => digest(req.ip || 'unknown').slice(0, 32);
  function guest(req, _res, next) {
    try {
      req.guest = tokens.verify(req.headers.authorization?.replace(/^Bearer /, ''), 'guest');
      if (req.guest.event !== digest(config.eventKey)) fail(401, 'invalid_token', 'Please reopen the current wedding invitation.');
      next();
    } catch (e) { next(e); }
  }
  function admin(req, _res, next) {
    try {
      const raw = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('wedding_owner='))?.slice(14);
      req.owner = tokens.verify(raw, 'admin');
      if (req.owner.key !== digest(config.adminKey)) fail(401, 'invalid_token', 'Please sign in again.');
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== config.publicBaseUrl) fail(403, 'origin_denied', 'Use the owner page to make changes.');
      next();
    } catch (e) { next(e); }
  }
  function uploadAccess(req, _res, next) {
    try {
      if (!/^[a-f0-9]{40}$/.test(req.params.id)) fail(404, 'not_found', 'Upload not found.');
      const proof = tokens.verify(req.headers['x-upload-token'], 'upload');
      if (proof.id !== req.params.id) fail(403, 'upload_denied', 'This upload belongs to another file.');
      next();
    } catch (e) { next(e); }
  }
  const progress = row => ({ id: row.id, offset: row.offset || 0, complete: row.status === 'complete' });
  function view(row) {
    const link = kind => `${config.publicBaseUrl}/api/media/${row.id}/${kind}?token=${encodeURIComponent(tokens.sign({ purpose: 'media', id: row.id, kind, event: digest(config.eventKey) }, HOUR))}`;
    return { id: row.id, name: row.name, mimeType: row.mimeType, size: row.size, caption: row.caption,
      guestName: row.guestName, createdAt: row.createdAt, hidden: !!row.hidden, missingFromDrive: !!row.driveMissingAt,
      thumbnailUrl: link('thumbnail'), mediaUrl: link('original'), downloadUrl: link('download') };
  }
  function decodeCursor(raw) {
    if (!raw) return null;
    if (typeof raw !== 'string' || raw.length > 500) fail(400, 'invalid_cursor', 'Refresh the gallery and try again.');
    try {
      const value = JSON.parse(Buffer.from(raw, 'base64url').toString());
      if (!Number.isSafeInteger(value.createdAt) || !/^[a-f0-9]{40}$/.test(value.id)) throw new Error();
      return value;
    } catch { fail(400, 'invalid_cursor', 'Refresh the gallery and try again.'); }
  }
  async function gallery(req, res, owner = false) {
    const limit = Math.min(48, Math.max(1, Number(req.query.limit) || 24));
    if (!Number.isInteger(limit)) fail(400, 'invalid_limit', 'Invalid page size.');
    const page = await store.page(decodeCursor(req.query.cursor), limit, owner);
    let rows = page.rows;
    if (!owner && rows.length) {
      const event = await store.getEvent();
      rows = (await Promise.all(rows.map(async row => {
        try {
          const file = await drive.metadata(row.driveId);
          if (file && !file.trashed && file.parents?.includes(event.folderId)) return row;
        } catch (error) {
          // A temporary Drive problem should not empty the album. Only a confirmed
          // missing file is removed from guest view.
          if (error.code !== 'drive_not_found') return row;
        }
        await store.markDriveMissing(row.id, clock());
        return null;
      }))).filter(Boolean);
    }
    const nextCursor = page.hasMore && page.last ? Buffer.from(JSON.stringify({ id: page.last.id, createdAt: page.last.createdAt })).toString('base64url') : null;
    res.json({ items: rows.map(view), nextCursor });
  }
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/config', async (_req, res) => {
    const event = await store.getEvent();
    res.json({ coupleNames: 'Raquel & Aaron', title: 'Our wedding, through your eyes', weddingDate: 'October 25, 2026',
      maxFileBytes: config.maxFileBytes, chunkBytes: config.chunkBytes, configured: !!event.connected, uploadsOpen: !!event.connected && !!event.uploadsOpen });
  });
  app.post('/api/guest/session', async (req, res) => {
    await store.rate(`guest-${ipKey(req)}`, 600, HOUR, clock());
    if (!equal(req.body?.eventKey, config.eventKey)) fail(401, 'invalid_event', 'That album code does not match. Please use the wedding invitation link.');
    res.json({ token: tokens.sign({ purpose: 'guest', sid: nonce(), event: digest(config.eventKey) }, 12 * HOUR), expiresAt: clock() + 12 * HOUR });
  });
  app.get('/api/gallery', guest, (req, res) => gallery(req, res));
  app.post('/api/uploads', guest, async (req, res) => {
    await store.rate(`uploads-${req.guest.sid}`, 240, HOUR, clock());
    await uploads.expire();
    const row = await uploads.create(req.body);
    res.json({ ...progress(row), uploadToken: tokens.sign({ purpose: 'upload', id: row.id }, 48 * HOUR), chunkBytes: config.chunkBytes });
  });
  app.get('/api/uploads/:id', guest, uploadAccess, async (req, res) => res.json(progress(await uploads.status(req.params.id))));
  app.put('/api/uploads/:id', guest, uploadAccess, async (req, res) => {
    const event = await store.getEvent();
    if (!event.uploadsOpen) fail(503, 'uploads_closed', 'Uploads are currently paused. Please try again later.', true);
    res.json(progress(await uploads.chunk(req.params.id, req)));
  });
  app.delete('/api/uploads/:id', guest, uploadAccess, async (req, res) => res.json({ id: (await uploads.cancel(req.params.id)).id, cancelled: true }));
  app.get('/api/media/:id/:kind', async (req, res) => {
    const proof = tokens.verify(req.query.token, 'media');
    const { id, kind } = req.params;
    if (proof.id !== id || proof.kind !== kind || proof.event !== digest(config.eventKey) || !['thumbnail', 'original', 'download'].includes(kind)) fail(403, 'media_denied', 'This media link is invalid. Refresh the gallery.');
    const row = await store.getUpload(id);
    if (!row || row.status !== 'complete' || row.hidden) fail(404, 'not_found', 'This photo or video is no longer in the shared album.');
    if (req.headers.range && !/^bytes=\d+-\d*$/.test(req.headers.range)) fail(416, 'invalid_range', 'That media range is not supported.');
    const upstream = kind === 'thumbnail' ? await drive.thumbnail(row) : await drive.media(row, req.headers.range);
    res.status(upstream.status);
    // Omit Content-Length so Node streams chunked responses beyond Cloud Run's fixed-response limit.
    for (const name of ['content-type', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(name); if (value) res.set(name, value);
    }
    if (kind === 'download') res.set('Content-Disposition', `attachment; filename="${row.name.replace(/[^a-zA-Z0-9._ -]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(row.name).replace(/'/g, '%27')}`);
    else res.set('Content-Disposition', 'inline');
    // Do not let browsers keep hidden media indefinitely; server verifies visibility on each request.
    res.set('Cache-Control', 'private, no-store');
    if (!upstream.body) return res.end();
    try { await pipeline(Readable.fromWeb(upstream.body), res); } catch (error) { if (!res.destroyed) throw error; }
  });
  app.get('/admin', (_req, res) => {
    res.set({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    res.type('html').send(adminPage);
  });
  app.use('/owner-assets', express.static(new URL('../public', import.meta.url).pathname));
  app.post('/api/admin/session', async (req, res) => {
    if (req.headers.origin !== config.publicBaseUrl) fail(403, 'origin_denied', 'Open the owner page to sign in.');
    await store.rate(`admin-${ipKey(req)}`, 12, HOUR, clock());
    if (!equal(req.body?.adminKey, config.adminKey)) fail(401, 'invalid_admin', 'The owner key does not match.');
    const token = tokens.sign({ purpose: 'admin', sid: nonce(), key: digest(config.adminKey) }, 12 * HOUR);
    res.set('Set-Cookie', `wedding_owner=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${config.development ? '' : '; Secure'}`);
    res.json({ ok: true });
  });
  app.post('/api/admin/logout', admin, (_req, res) => { res.set('Set-Cookie', 'wedding_owner=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure'); res.json({ ok: true }); });
  app.get('/api/admin/status', admin, async (_req, res) => {
    const event = await store.getEvent(); const setup = await drive.setup();
    let quota = null, connectionError = null;
    if (setup.connected) { try { quota = await drive.quota(); } catch (e) { connectionError = e.message; } }
    res.json({ ...setup, connected: setup.connected && !connectionError && !!event.folderId,
      connectionError, quota, uploadsOpen: !!event.uploadsOpen, usedBytes: event.usedBytes || 0,
      reservedBytes: event.reservedBytes || 0, activeUploads: event.activeUploads || 0,
      connectedAt: event.connectedAt || null, folderUrl: event.folderId ? `https://drive.google.com/drive/folders/${event.folderId}` : null,
      invitationUrl: `${config.frontendUrl}#event=${encodeURIComponent(config.eventKey)}`,
      oauthCallbackUrl: `${config.publicBaseUrl}/api/admin/oauth/callback`,
      oauthProjectStatus: 'testing', ownerEmail: config.ownerEmail });
  });
  app.post('/api/admin/oauth/start', admin, async (req, res) => {
    const state = nonce(); const verifier = nonce() + nonce();
    await store.putState(digest(state), { sid: req.owner.sid, verifier, expiresAt: clock() + 10 * 60000 });
    res.json({ url: await drive.authorizeUrl(state, verifier) });
  });
  app.get('/api/admin/oauth/callback', admin, async (req, res) => {
    if (typeof req.query.state !== 'string' || req.query.state.length > 200) fail(400, 'invalid_state', 'Start the connection again from the owner page.');
    const state = await store.consumeState(digest(req.query.state), req.owner.sid, clock());
    if (req.query.error) return res.redirect('/admin#connection=cancelled');
    if (typeof req.query.code !== 'string' || req.query.code.length > 4000) fail(400, 'invalid_code', 'Google did not return a valid authorization code.');
    await drive.connect(req.query.code, state.verifier);
    const folderId = await drive.ensureFolder();
    await store.patchEvent({ connected: true, folderId, connectedAt: clock() });
    res.redirect('/admin#connection=success');
  });
  app.post('/api/admin/settings', admin, async (req, res) => {
    if (typeof req.body?.uploadsOpen !== 'boolean') fail(400, 'invalid_setting', 'Choose whether uploads are open.');
    if (req.body.uploadsOpen) {
      const setup = await drive.setup(); const event = await store.getEvent();
      if (!setup.connected || !event.folderId) fail(409, 'drive_not_connected', 'Connect Google Drive before opening uploads.');
      await drive.quota();
    }
    await store.patchEvent({ uploadsOpen: req.body.uploadsOpen }); res.json({ ok: true });
  });
  app.get('/api/admin/gallery', admin, (req, res) => gallery(req, res, true));
  app.post('/api/admin/media/:id', admin, async (req, res) => {
    if (typeof req.body?.hidden !== 'boolean') fail(400, 'invalid_setting', 'Choose whether the item is hidden.');
    const row = await store.getUpload(req.params.id);
    if (!row || row.status !== 'complete') fail(404, 'not_found', 'This completed upload was not found.');
    await store.patchUpload(req.params.id, { hidden: req.body.hidden }); res.json({ ok: true });
  });
  app.use((_req, _res, next) => next(new AppError(404, 'not_found', 'This page was not found.')));
  app.use((error, req, res, _next) => {
    if (res.headersSent || res.destroyed) return res.end();
    const known = error instanceof AppError;
    const status = known ? error.status : error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
    // Log no URLs, query strings, request bodies, upstream payloads, cookies, or credentials.
    if (!known && status === 500) console.error(JSON.stringify({ level: 'error', code: 'internal_error', name: error.name, upstreamCode: typeof error.code === 'number' ? error.code : undefined }));
    res.status(status).json({ error: { code: known ? error.code : 'request_failed', message: known ? error.message : status === 500 ? 'Something went wrong. Please try again.' : 'The request could not be read.', retryable: known ? error.retryable : status >= 500 } });
  });
  return app;
}
