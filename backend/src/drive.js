import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { OAuth2Client } from 'google-auth-library';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { AppError, fail } from './core.js';

const API = 'https://www.googleapis.com/drive/v3';
const FIELDS = 'id,name,mimeType,size,trashed,thumbnailLink,parents';
export class Secrets {
  constructor(config) { this.config = config; this.client = new SecretManagerServiceClient(); this.cache = new Map(); }
  name(id) { return `projects/${this.config.projectId}/secrets/${id}`; }
  async read(id) {
    const cached = this.cache.get(id); if (cached?.until > Date.now()) return cached.value;
    let value = {};
    try { const [version] = await this.client.accessSecretVersion({ name: `${this.name(id)}/versions/latest` }); value = JSON.parse(version.payload.data.toString('utf8') || '{}'); }
    catch (error) { if (![5, 9].includes(error.code)) throw new AppError(503, 'secret_unavailable', 'The owner connection settings are unavailable. Please try again later.', true); }
    this.cache.set(id, { value, until: Date.now() + 60000 }); return value;
  }
  async write(id, value) { await this.client.addSecretVersion({ parent: this.name(id), payload: { data: Buffer.from(JSON.stringify(value)) } }); this.cache.set(id, { value, until: Date.now() + 60000 }); }
}
export class GoogleDrive {
  constructor(config, secrets = new Secrets(config)) { this.config = config; this.secrets = secrets; this.authCache = null; }
  async setup() { const oauth = await this.secrets.read(this.config.oauthSecret); const refresh = await this.secrets.read(this.config.refreshSecret); return { oauthConfigured: !!(oauth.clientId && oauth.clientSecret), connected: !!refresh.refreshToken }; }
  async oauthClient() {
    const oauth = await this.secrets.read(this.config.oauthSecret);
    if (!oauth.clientId || !oauth.clientSecret) fail(503, 'oauth_setup_required', 'Create a Google OAuth web client and save its clientId and clientSecret in the wedding-photos-oauth secret.');
    return new OAuth2Client(oauth.clientId, oauth.clientSecret, `${this.config.publicBaseUrl}/api/admin/oauth/callback`);
  }
  async auth() {
    if (this.authCache && this.authCache.until > Date.now()) return this.authCache.client;
    const client = await this.oauthClient(); const refresh = await this.secrets.read(this.config.refreshSecret);
    if (!refresh.refreshToken || refresh.ownerEmail !== this.config.ownerEmail) fail(503, 'drive_not_connected', 'The couple needs to connect their Google Drive before uploads can begin.', true);
    client.setCredentials({ refresh_token: refresh.refreshToken }); this.authCache = { client, until: Date.now() + 60000 }; return client;
  }
  async token() {
    try { const token = await (await this.auth()).getAccessToken(); if (!token.token) throw new Error(); return token.token; }
    catch (error) { if (error instanceof AppError) throw error; fail(503, 'drive_reconnect_required', 'The couple needs to reconnect Google Drive. Your file can be retried afterward.', true); }
  }
  async authorizeUrl(state, verifier) {
    return (await this.oauthClient()).generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'], state, login_hint: this.config.ownerEmail, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
  }
  async connect(code, verifier) {
    const client = await this.oauthClient(); let tokens;
    try { ({ tokens } = await client.getToken({ code, codeVerifier: verifier })); } catch { fail(400, 'oauth_exchange_failed', 'Google could not complete the connection. Please try connecting again.'); }
    let payload;
    try {
      const oauth = await this.secrets.read(this.config.oauthSecret);
      payload = (await client.verifyIdToken({ idToken: tokens.id_token, audience: oauth.clientId })).getPayload();
    } catch { fail(403, 'owner_mismatch', 'Google could not verify the owner account.'); }
    if (!payload?.email_verified || payload.email?.toLowerCase() !== this.config.ownerEmail.toLowerCase()) fail(403, 'owner_mismatch', `Please connect the configured owner account: ${this.config.ownerEmail}.`);
    if (!tokens.refresh_token) fail(400, 'refresh_missing', 'Google did not return an offline token. Reconnect and grant the requested access.');
    if (!tokens.scope?.split(' ').includes('https://www.googleapis.com/auth/drive.file')) fail(403, 'drive_permission_missing', 'Allow access to files created by this app, then reconnect.');
    await this.secrets.write(this.config.refreshSecret, { refreshToken: tokens.refresh_token, ownerEmail: payload.email }); this.authCache = null;
  }
  async request(url, options = {}) {
    let response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try { response = await fetch(url, { ...options, redirect: options.redirect || 'error', signal: options.signal || controller.signal, headers: { Authorization: `Bearer ${await this.token()}`, ...options.headers } }); }
    catch (error) { if (error instanceof AppError) throw error; fail(503, 'drive_unavailable', 'The connection was interrupted. Checking the upload before retrying will preserve its progress.', true); }
    finally { clearTimeout(timeout); }
    return response;
  }
  check(response) {
    if (response.ok) return;
    if (response.status === 404) fail(404, 'drive_not_found', 'This file is no longer available.');
    if (response.status === 401) { this.authCache = null; fail(503, 'drive_reconnect_required', 'The couple needs to reconnect Google Drive.', true); }
    if (response.status === 403 || response.status === 429 || response.status >= 500) fail(503, 'drive_unavailable', 'Google Drive is temporarily unavailable or full. Please retry later.', true);
    fail(502, 'drive_error', 'Google Drive could not complete this request. Please retry.', true);
  }
  async ensureFolder() {
    const q = "trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='weddingPhotosApp' and value='raquel-aaron-2026' }";
    const response = await this.request(`${API}/files?${new URLSearchParams({ q, fields: 'files(id,name)', pageSize: '10' })}`); this.check(response);
    const { files } = await response.json(); if (files?.[0]) return files[0].id;
    const created = await this.request(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Raquel & Aaron — Wedding Photos', mimeType: 'application/vnd.google-apps.folder', appProperties: { weddingPhotosApp: 'raquel-aaron-2026' } }) }); this.check(created); return (await created.json()).id;
  }
  async quota() { const response = await this.request(`${API}/about?fields=storageQuota`); this.check(response); return (await response.json()).storageQuota; }
  async generateId() { const response = await this.request(`${API}/files/generateIds?count=1&space=drive&type=files`); this.check(response); return (await response.json()).ids[0]; }
  async initiate(row, folderId) {
    const response = await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,mimeType', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': row.mimeType, 'X-Upload-Content-Length': String(row.size) }, body: JSON.stringify({ id: row.driveId, name: row.name, mimeType: row.mimeType, parents: [folderId], appProperties: { weddingPhotosApp: 'raquel-aaron-2026', uploadId: row.id } }) });
    if (response.status === 409) { const file = await this.metadata(row.driveId); if (Number(file.size) === row.size) return { complete: true }; }
    this.check(response); const location = response.headers.get('location');
    if (!location || !this.validSession(location)) fail(502, 'invalid_drive_session', 'Google Drive did not start a valid upload session.', true);
    return { sessionUrl: location };
  }
  validSession(value) { try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'www.googleapis.com' && url.pathname === '/upload/drive/v3/files' && !url.username && !url.password; } catch { return false; } }
  async metadata(id) { const response = await this.request(`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}`); this.check(response); return response.json(); }
  async result(response, row) {
    if (response.status === 308) { const match = /^bytes=0-(\d+)$/.exec(response.headers.get('range') || ''); const offset = match ? Number(match[1]) + 1 : 0; if (offset > row.size) fail(502, 'invalid_drive_offset', 'Google returned invalid upload progress.', true); return { offset, complete: false }; }
    if (response.status === 200 || response.status === 201) { await response.arrayBuffer(); return { offset: row.size, complete: true }; }
    if (response.status === 404 || response.status === 410) {
      try { const file = await this.metadata(row.driveId); if (!file.trashed && Number(file.size) === row.size) return { offset: row.size, complete: true }; } catch (error) { if (error.code !== 'drive_not_found') throw error; }
      fail(410, 'upload_expired', 'This upload session has expired. Please select the file again.');
    }
    this.check(response); fail(502, 'drive_error', 'Google returned unexpected upload progress.', true);
  }
  async status(row) {
    if (!this.validSession(row.sessionUrl)) fail(502, 'invalid_drive_session', 'This upload session is invalid.');
    // Drive uses 308 as upload progress. Manual mode exposes that response without
    // following redirects; redirect:error rejects it even without a Location header.
    const response = await this.request(row.sessionUrl, { method: 'PUT', redirect: 'manual', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${row.size}` } }); return this.result(response, row);
  }
  async chunk(row, range, input) {
    if (!this.validSession(row.sessionUrl)) fail(502, 'invalid_drive_session', 'This upload session is invalid.');
    let bytes = 0;
    const counter = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; if (bytes > range.length) done(new AppError(400, 'invalid_length', 'The upload chunk was larger than expected.')); else done(null, chunk); }, flush(done) { done(bytes === range.length ? null : new AppError(400, 'invalid_length', 'The upload chunk was interrupted.')); } });
    // Pipeline propagates browser disconnects to fetch; neither the file nor full chunk is buffered.
    const feeding = pipeline(input, counter).catch(error => { counter.destroy(error); throw error; });
    // Attach a rejection observer before fetch starts so a disconnected request cannot become unhandled.
    feeding.catch(() => {});
    let response;
    try { response = await this.request(row.sessionUrl, { method: 'PUT', redirect: 'manual', duplex: 'half', headers: { 'Content-Length': String(range.length), 'Content-Type': row.mimeType, 'Content-Range': `bytes ${range.start}-${range.end}/${range.total}` }, body: counter }); await feeding; }
    catch (error) { counter.destroy(); await feeding.catch(() => {}); throw error; }
    return this.result(response, row);
  }
  async media(row, range) { const response = await this.request(`${API}/files/${encodeURIComponent(row.driveId)}?alt=media`, { headers: range ? { Range: range } : {} }); if (response.status !== 416) this.check(response); return response; }
  async thumbnail(row) {
    const metadata = await this.metadata(row.driveId); if (!metadata.thumbnailLink) fail(404, 'preview_unavailable', 'A preview is not available yet. You can download the original.');
    const url = new URL(metadata.thumbnailLink);
    if (url.protocol !== 'https:' || !/^lh[0-9]+\.googleusercontent\.com$/.test(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) fail(404, 'preview_unavailable', 'A preview is not available for this file.');
    const response = await this.request(url.toString()); this.check(response);
    if (!/^image\/(jpeg|png|webp|gif|avif)(?:;|$)/.test(response.headers.get('content-type') || '')) fail(404, 'preview_unavailable', 'A preview is not available for this file.');
    return response;
  }
}
