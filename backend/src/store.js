import { Firestore, FieldPath } from '@google-cloud/firestore';
import { fail } from './core.js';

export class FirestoreStore {
  constructor(config) { this.db = new Firestore({ projectId: config.projectId, databaseId: config.databaseId }); this.root = this.db.collection('weddingPhotos'); this.eventRef = this.root.doc('event'); this.uploads = this.eventRef.collection('uploads'); }
  async getEvent() { return (await this.eventRef.get()).data() || { uploadsOpen: false, usedBytes: 0, reservedBytes: 0, activeUploads: 0 }; }
  async patchEvent(data) { await this.eventRef.set(data, { merge: true }); }
  async getUpload(id) { return (await this.uploads.doc(id).get()).data() || null; }
  async patchUpload(id, data) { await this.uploads.doc(id).update(data); }
  async markDriveMissing(id, now) {
    return this.db.runTransaction(async tx => {
      const ref = this.uploads.doc(id); const [snap, eventSnap] = await tx.getAll(ref, this.eventRef);
      const row = snap.data(); const event = eventSnap.data() || {};
      if (!row || row.driveMissingAt) return row || null;
      tx.update(ref, { hidden: true, driveMissingAt: now });
      tx.set(this.eventRef, { usedBytes: Math.max(0, (event.usedBytes || 0) - (row.size || 0)) }, { merge: true });
      return { ...row, hidden: true, driveMissingAt: now };
    });
  }
  async reserve(record, config) {
    return this.db.runTransaction(async tx => {
      const ref = this.uploads.doc(record.id); const [existing, eventSnap] = await tx.getAll(ref, this.eventRef);
      if (existing.exists) return existing.data();
      const event = eventSnap.data() || {};
      if (!event.uploadsOpen || !event.folderId || !event.connected) fail(503, 'uploads_closed', 'Uploads are not open yet. Please try again later.', true);
      if ((event.activeUploads || 0) >= config.maxActiveUploads) fail(429, 'upload_busy', 'Many memories are arriving at once. Please try again shortly.', true);
      if ((event.usedBytes || 0) + (event.reservedBytes || 0) + record.size > config.maxEventBytes) fail(507, 'event_full', 'The wedding collection is full. Please let the couple know.');
      tx.create(ref, record);
      tx.set(this.eventRef, { activeUploads: (event.activeUploads || 0) + 1, reservedBytes: (event.reservedBytes || 0) + record.size }, { merge: true });
      return record;
    });
  }
  async acquire(id, leaseId, now) {
    return this.db.runTransaction(async tx => {
      const ref = this.uploads.doc(id); const snap = await tx.get(ref); const row = snap.data();
      if (!row) fail(404, 'not_found', 'This upload was not found.');
      if (row.leaseUntil > now) fail(409, 'upload_busy', 'This upload is already being processed. Please retry shortly.', true);
      tx.update(ref, { leaseId, leaseUntil: now + 180000 }); return row;
    });
  }
  async release(id, leaseId) {
    await this.db.runTransaction(async tx => { const ref = this.uploads.doc(id); const row = (await tx.get(ref)).data(); if (row?.leaseId === leaseId) tx.update(ref, { leaseId: null, leaseUntil: 0 }); });
  }
  async finish(id, status, extra = {}) {
    return this.db.runTransaction(async tx => {
      const ref = this.uploads.doc(id); const [snap, eventSnap] = await tx.getAll(ref, this.eventRef); const row = snap.data(); const event = eventSnap.data() || {};
      if (!row) fail(404, 'not_found', 'This upload was not found.');
      if (['complete', 'cancelled', 'expired', 'rejected'].includes(row.status)) return row;
      const updated = { ...row, ...extra, status };
      tx.update(ref, { ...extra, status });
      tx.set(this.eventRef, { activeUploads: Math.max(0, (event.activeUploads || 0) - 1), reservedBytes: Math.max(0, (event.reservedBytes || 0) - row.size), usedBytes: (event.usedBytes || 0) + (status === 'complete' ? row.size : 0) }, { merge: true });
      return updated;
    });
  }
  async page(cursor, limit, admin = false) {
    let query = this.uploads.orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
    if (cursor) query = query.startAfter(cursor.createdAt, cursor.id);
    // Read in bounded batches to avoid a composite index and never return partial uploads.
    const docs = (await query.limit(limit).get()).docs.map(s => s.data());
    return { rows: docs.filter(row => row.status === 'complete' && (admin || !row.hidden)), last: docs.at(-1), hasMore: docs.length === limit };
  }
  async expired(now) { return (await this.uploads.where('expiresAt', '<', now).limit(30).get()).docs.map(s => s.data()).filter(row => ['creating', 'uploading'].includes(row.status)); }
  async rate(key, limit, windowMs, now) {
    const ref = this.eventRef.collection('rateLimits').doc(key);
    await this.db.runTransaction(async tx => { const row = (await tx.get(ref)).data(); const fresh = !row || row.until < now; const count = fresh ? 1 : row.count + 1; if (count > limit) fail(429, 'rate_limited', 'Please wait a moment and try again.', true); tx.set(ref, { count, until: fresh ? now + windowMs : row.until, expiresAt: new Date(now + windowMs * 2) }); });
  }
  async putState(id, row) { await this.eventRef.collection('oauthStates').doc(id).create(row); }
  async consumeState(id, sid, now) { return this.db.runTransaction(async tx => { const ref = this.eventRef.collection('oauthStates').doc(id); const row = (await tx.get(ref)).data(); if (!row || row.sid !== sid || row.expiresAt < now) fail(400, 'invalid_state', 'The connection request expired. Start again from the owner page.'); tx.delete(ref); return row; }); }
}
