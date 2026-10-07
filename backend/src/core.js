import { createHmac, timingSafeEqual, randomBytes, createHash } from 'node:crypto';

export class AppError extends Error {
  constructor(status, code, message, retryable = false) { super(message); Object.assign(this, { status, code, retryable }); }
}
export const fail = (status, code, message, retryable) => { throw new AppError(status, code, message, retryable); };
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export const nonce = () => randomBytes(24).toString('base64url');
export function equal(a, b) {
  const aa = Buffer.from(String(a ?? '')); const bb = Buffer.from(String(b ?? ''));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function signer(key, clock = Date.now) {
  if (!key || key.length < 32) throw new Error('SIGNING_KEY must have at least 32 characters.');
  const mac = value => createHmac('sha256', key).update(value).digest('base64url');
  return {
    sign(payload, ttl) { const body = Buffer.from(JSON.stringify({ ...payload, exp: clock() + ttl })).toString('base64url'); return `${body}.${mac(body)}`; },
    verify(token, purpose) {
      if (typeof token !== 'string' || token.length > 4096) fail(401, 'invalid_token', 'Please reopen your wedding invitation link.');
      const [body, signature, extra] = token.split('.');
      if (extra || !body || !signature || !equal(signature, mac(body))) fail(401, 'invalid_token', 'Please reopen your wedding invitation link.');
      let data; try { data = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { fail(401, 'invalid_token', 'The access link is invalid.'); }
      if (data.purpose !== purpose || !Number.isFinite(data.exp) || data.exp <= clock()) fail(401, 'expired_token', 'Your access has expired. Reopen your wedding invitation link.');
      return data;
    },
  };
}
export const MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif', 'image/tiff', 'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v', 'video/3gpp', 'video/3gpp2', 'video/mpeg']);
export function uploadInput(body, maxFileBytes) {
  const { name, mimeType, size, guestName = '', caption = '', uploadKey } = body ?? {};
  if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\x00-\x1f\x7f/\\]/.test(name)) fail(400, 'invalid_name', 'Use a filename of 1–200 characters without slashes.');
  if (!MIMES.has(mimeType)) fail(415, 'unsupported_type', 'Please choose a supported photo or video.');
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxFileBytes) fail(400, 'invalid_size', 'This file is empty or exceeds the 1 GB limit.');
  if (typeof guestName !== 'string' || guestName.length > 80 || typeof caption !== 'string' || caption.length > 500) fail(400, 'invalid_text', 'Names may have 80 characters and captions 500 characters.');
  if (typeof uploadKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(uploadKey)) fail(400, 'invalid_upload_key', 'Please choose the file again to start a fresh upload.');
  return { name: name.trim(), mimeType, size, guestName: guestName.trim(), caption: caption.trim(), uploadKey };
}
export function parseRange(header, size, maxChunk) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header || '');
  if (!match) fail(400, 'invalid_range', 'A valid upload range is required.');
  const [start, end, total] = match.slice(1).map(Number); const length = end - start + 1;
  if (![start, end, total].every(Number.isSafeInteger) || total !== size || start < 0 || end < start || end >= size || length > maxChunk || (end + 1 < size && length % 262144 !== 0)) fail(400, 'invalid_range', 'The upload chunk does not match the file size or chunk limit.');
  return { start, end, total, length };
}
export function settings(env = process.env) {
  const config = {
    projectId: env.PROJECT_ID || 'wedding-490801', databaseId: env.FIRESTORE_DATABASE || '(default)',
    ownerEmail: env.OWNER_EMAIL, frontendOrigin: env.FRONTEND_ORIGIN || 'https://aaronkbutler.github.io',
    frontendUrl: env.FRONTEND_URL || 'https://aaronkbutler.github.io/wedding-photos/', publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    adminKey: env.ADMIN_KEY, signingKey: env.SIGNING_KEY, eventKey: env.EVENT_KEY,
    oauthSecret: env.OAUTH_CONFIG_SECRET || 'wedding-photos-oauth', refreshSecret: env.DRIVE_REFRESH_SECRET || 'wedding-photos-drive-refresh',
    maxFileBytes: 1073741824, chunkBytes: 8388608, maxEventBytes: Number(env.MAX_EVENT_BYTES || 107374182400), maxActiveUploads: Number(env.MAX_ACTIVE_UPLOADS || 30),
    development: env.NODE_ENV === 'development',
  };
  if (!config.adminKey || config.adminKey.length < 24 || !config.eventKey || config.eventKey.length < 24) throw new Error('ADMIN_KEY and EVENT_KEY must each have at least 24 characters.');
  if (!config.ownerEmail || !config.ownerEmail.includes('@')) throw new Error('OWNER_EMAIL is required.');
  if (!Number.isSafeInteger(config.maxEventBytes) || config.maxEventBytes < config.maxFileBytes || !Number.isSafeInteger(config.maxActiveUploads) || config.maxActiveUploads < 1) throw new Error('Invalid upload limits.');
  if (!config.publicBaseUrl || (!config.publicBaseUrl.startsWith('https://') && !config.development)) throw new Error('PUBLIC_BASE_URL must be the HTTPS backend URL.');
  return config;
}
