import { digest, fail, nonce, parseRange, uploadInput } from './core.js';

export class Uploads {
  constructor({ store, drive, config, clock = Date.now }) { Object.assign(this, { store, drive, config, clock }); }
  async create(body) {
    const input = uploadInput(body, this.config.maxFileBytes); const id = digest(input.uploadKey).slice(0, 40); const fingerprint = digest(JSON.stringify(input));
    const row = await this.store.reserve({ ...input, id, fingerprint, status: 'creating', offset: 0, hidden: false, createdAt: this.clock(), expiresAt: this.clock() + 15 * 60000, leaseUntil: 0 }, this.config);
    if (row.fingerprint !== fingerprint) fail(409, 'upload_key_reused', 'This upload identifier belongs to a different file. Select the file again.');
    return this.locked(id, async current => {
      this.active(current);
      if (current.status === 'complete' || current.sessionUrl) return current;
      if (!current.driveId) { current.driveId = await this.drive.generateId(); await this.store.patchUpload(id, { driveId: current.driveId }); }
      const event = await this.store.getEvent(); const result = await this.drive.initiate(current, event.folderId);
      if (result.complete) return this.complete(current);
      await this.store.patchUpload(id, { sessionUrl: result.sessionUrl, status: 'uploading' }); return { ...current, sessionUrl: result.sessionUrl, status: 'uploading' };
    });
  }
  active(row) {
    if (['cancelled', 'expired', 'rejected'].includes(row.status) || (row.status !== 'complete' && row.expiresAt < this.clock())) fail(410, 'upload_expired', 'This upload has expired or was cancelled. Select the file again.');
  }
  async locked(id, fn) { const lease = nonce(); const row = await this.store.acquire(id, lease, this.clock()); try { return await fn(row); } catch (error) { if (error.code === 'upload_expired') await this.store.finish(id, 'expired', { expiresAt: 253402300799999 }); throw error; } finally { await this.store.release(id, lease); } }
  async complete(row) {
    const file = await this.drive.metadata(row.driveId); const event = await this.store.getEvent();
    if (file.trashed || Number(file.size) !== row.size || file.mimeType !== row.mimeType || !file.parents?.includes(event.folderId)) {
      await this.store.finish(row.id, 'rejected', { hidden: true, expiresAt: 253402300799999 }); fail(502, 'verification_failed', 'The saved file did not match the upload. Please contact the couple before retrying.');
    }
    return this.store.finish(row.id, 'complete', { offset: row.size, completedAt: this.clock(), sessionUrl: null, expiresAt: 253402300799999 });
  }
  async sync(row) {
    this.active(row); if (row.status === 'complete') return row;
    if (!row.sessionUrl) fail(409, 'upload_starting', 'The upload is still starting. Please retry.', true);
    const status = await this.drive.status(row); if (status.complete) return this.complete(row);
    await this.store.patchUpload(row.id, { offset: status.offset, expiresAt: this.clock() + 15 * 60000 }); return { ...row, offset: status.offset };
  }
  async status(id) { return this.locked(id, row => this.sync(row)); }
  async chunk(id, req) {
    return this.locked(id, async row => {
      this.active(row); const range = parseRange(req.headers['content-range'], row.size, this.config.chunkBytes);
      if (req.headers['content-type']?.split(';')[0] !== 'application/octet-stream') fail(415, 'invalid_content_type', 'Upload chunks must use application/octet-stream.');
      if (!/^\d+$/.test(req.headers['content-length'] || '') || Number(req.headers['content-length']) !== range.length) fail(400, 'invalid_length', 'The upload chunk length does not match its range.');
      if (row.status === 'complete') { req.resume(); return row; }
      // Reconcile with Drive before every write: a prior attempt may have succeeded after the browser lost its response.
      const current = await this.sync(row);
      if (current.status === 'complete' || range.end < current.offset) { req.resume(); return current; }
      if (range.start !== current.offset) fail(409, 'offset_mismatch', 'Check upload progress and retry from the saved position.', true);
      const status = await this.drive.chunk(current, range, req); if (status.complete) return this.complete(current);
      await this.store.patchUpload(id, { offset: status.offset, expiresAt: this.clock() + 15 * 60000 }); return { ...current, offset: status.offset };
    });
  }
  async cancel(id) { return this.locked(id, async row => { if (row.status === 'complete') fail(409, 'already_complete', 'This file has already been saved.'); return this.store.finish(id, 'cancelled', { sessionUrl: null, expiresAt: 253402300799999 }); }); }
  async expire() { const rows = await this.store.expired(this.clock()); for (const row of rows) { if (row.leaseUntil > this.clock()) continue; try { await this.locked(row.id, current => this.store.finish(current.id, 'expired', { sessionUrl: null, expiresAt: 253402300799999 })); } catch (error) { if (error.code !== 'upload_busy') throw error; } } }
}
