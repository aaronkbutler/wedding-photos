(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const demo = new URLSearchParams(location.search).get('demo') === '1';
  const apiBase = (window.WEDDING_PHOTOS_API || location.origin).replace(/\/+$/, '');
  const storageKey = `wedding-photo-event:${apiBase}`;
  const defaults = {maxFileBytes: 1073741824, chunkBytes: 8388608, uploadsOpen: true};
  const state = {config: defaults, eventKey: '', token: '', expiresAt: 0, authPromise: null, jobs: [], processing: false, items: [], cursor: null, galleryBusy: false, filter: 'all', viewerIndex: 0, viewerLoad: 0};
  const mimeByExtension = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif',gif:'image/gif',tif:'image/tiff',tiff:'image/tiff',avif:'image/avif',mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',mpeg:'video/mpeg',mpg:'video/mpeg',m4v:'video/x-m4v', '3gp':'video/3gpp','3g2':'video/3gpp2'};
  const allowedMimes = new Set(Object.values(mimeByExtension));

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function bytes(value) {
    if (value === 0) return '0 B';
    if (value >= 1073741824) return `${(value / 1073741824).toFixed(value % 1073741824 ? 1 : 0)} GB`;
    if (value >= 1048576) return `${(value / 1048576).toFixed(value < 10485760 ? 1 : 0)} MB`;
    return `${Math.max(1, Math.round(value / 1024))} KB`;
  }
  function notice(message = '', error = false) {
    $('global-notice').textContent = message;
    $('global-notice').hidden = !message;
    $('global-notice').classList.toggle('error', error);
  }
  function rememberEvent(key) {
    state.eventKey = key;
    try { sessionStorage.setItem(storageKey, key); } catch { /* Private/embedded browsers can deny storage. */ }
    const direct = new URL(location.href);
    direct.hash = new URLSearchParams({event: key}).toString();
    const standaloneLink = $('standalone-link');
    if (standaloneLink) standaloneLink.href = direct.href;
  }
  function readEvent() {
    const fragment = new URLSearchParams(location.hash.slice(1)).get('event');
    if (fragment) return fragment.trim();
    try { return sessionStorage.getItem(storageKey) || ''; } catch { return ''; }
  }
  function apiError(message, code = 'NETWORK_ERROR', retryable = true, status = 0) {
    return Object.assign(new Error(message), {code, retryable, status});
  }
  async function request(path, options = {}, authenticated = true, renewed = false) {
    if (authenticated) await ensureSession();
    const headers = new Headers(options.headers || {});
    if (authenticated) headers.set('Authorization', `Bearer ${state.token}`);
    let response;
    try { response = await fetch(`${apiBase}${path}`, {...options, headers, credentials: 'omit', referrerPolicy: 'no-referrer'}); }
    catch (error) {
      if (error.name === 'AbortError') throw error;
      throw apiError('Connection interrupted. Check your connection, then try again.');
    }
    let data;
    try { data = await response.json(); } catch { throw apiError('The album could not be reached. Please try again shortly.', 'INVALID_RESPONSE', response.status >= 500); }
    if (response.status === 401 && authenticated && !renewed) {
      state.token = '';
      state.expiresAt = 0;
      return request(path, options, true, true);
    }
    if (!response.ok) throw apiError(data.error?.message || 'Something went wrong. Please try again.', data.error?.code || 'REQUEST_FAILED', Boolean(data.error?.retryable), response.status);
    return data;
  }
  async function uploadChunk(job, start, end, renewed = false) {
    await ensureSession();
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const finish = () => job.controller.signal.removeEventListener('abort', abort);
      xhr.open('PUT', `${apiBase}/api/uploads/${encodeURIComponent(job.id)}`);
      xhr.responseType = 'text';
      xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
      xhr.setRequestHeader('X-Upload-Token', job.uploadToken);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('Content-Range', `bytes ${start}-${end - 1}/${job.file.size}`);
      xhr.upload.onprogress = event => {
        const sent = Math.min(end, start + Math.max(0, event.loaded || 0));
        job.displayOffset = Math.max(job.offset, sent);
        if (job.phase === 'uploading' && job.statusNode) {
          const percent = Math.floor(job.displayOffset / job.file.size * 100);
          job.statusNode.textContent = job.displayOffset >= job.file.size ? '100% · Finishing up…' : `${percent}% · Sharing ${bytes(job.displayOffset)} of ${bytes(job.file.size)}`;
          if (job.progressNode) job.progressNode.value = job.displayOffset;
        }
      };
      xhr.onerror = () => { finish(); job.displayOffset = job.offset; reject(apiError('Connection interrupted. Check your connection, then try again.')); };
      xhr.onabort = () => { finish(); job.displayOffset = job.offset; const error = new Error('Upload paused'); error.name = 'AbortError'; reject(error); };
      xhr.onload = async () => {
        finish();
        let data;
        try { data = JSON.parse(xhr.responseText); }
        catch { reject(apiError('The album could not be reached. Please try again shortly.', 'INVALID_RESPONSE', xhr.status >= 500)); return; }
        if (xhr.status === 401 && !renewed) {
          state.token = ''; state.expiresAt = 0; job.displayOffset = job.offset;
          try { resolve(await uploadChunk(job, start, end, true)); } catch (error) { reject(error); }
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          job.displayOffset = job.offset;
          reject(apiError(data.error?.message || 'Something went wrong. Please try again.', data.error?.code || 'REQUEST_FAILED', Boolean(data.error?.retryable), xhr.status));
          return;
        }
        resolve(data);
      };
      job.controller.signal.addEventListener('abort', abort, {once:true});
      xhr.send(job.file.slice(start, end));
    });
  }
  async function ensureSession() {
    if (state.token && Date.now() < state.expiresAt - 30000) return;
    if (state.authPromise) return state.authPromise;
    state.authPromise = (async () => {
      if (!state.eventKey) throw apiError('Please enter your album code to continue.', 'INVITE_REQUIRED', false);
      const data = await request('/api/guest/session', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({eventKey:state.eventKey})}, false);
      if (!data.token) throw apiError('The album could not be opened. Please try again.', 'INVALID_SESSION', false);
      state.token = data.token;
      const expiry = typeof data.expiresAt === 'number' ? (data.expiresAt < 1e12 ? data.expiresAt * 1000 : data.expiresAt) : Date.parse(data.expiresAt);
      state.expiresAt = Number.isFinite(expiry) ? expiry : Date.now() + 3600000;
    })();
    try { await state.authPromise; } finally { state.authPromise = null; }
  }
  function mediaURL(value) {
    if (!value || typeof value !== 'string') return '';
    try {
      const url = new URL(value, `${apiBase}/`);
      const base = new URL(apiBase);
      if (url.origin !== base.origin || !['https:', 'http:'].includes(url.protocol)) return '';
      return url.href;
    } catch { return ''; }
  }
  function applyConfig(data) {
    state.config = {...defaults, ...data};
    if (typeof data.coupleNames === 'string') $('couple-names').textContent = data.coupleNames;
    if (data.weddingDate && $('wedding-date')) {
      const text = String(data.weddingDate);
      const date = new Date(/^\d{4}-\d{2}-\d{2}/.test(text) ? `${text.slice(0, 10)}T12:00:00` : text);
      if (!Number.isNaN(date.getTime())) $('wedding-date').textContent = new Intl.DateTimeFormat('en-US',{month:'long', day:'numeric', year:'numeric'}).format(date);
    }
    $('file-limits').textContent = `Photos & videos · Up to ${bytes(state.config.maxFileBytes)} each`;
    $('choose-files').disabled = state.config.uploadsOpen === false;
    if (state.config.uploadsOpen === false) $('file-limits').textContent = 'Sharing has closed. Enjoy all the memories below.';
  }
  async function openAlbum(key) {
    $('invite-submit').disabled = true;
    $('invite-message').textContent = 'Opening our album…';
    state.token = '';
    state.eventKey = key;
    try {
      if (state.config.configured === false) throw apiError('Our album is still getting ready. Please come back soon.', 'NOT_READY', false);
      await ensureSession();
      rememberEvent(key);
      $('event-key').value = '';
      $('invite-message').textContent = '';
      $('invite-panel').hidden = true;
      $('guest-content').hidden = false;
      notice();
      await loadGallery(true);
    } catch (error) {
      $('invite-panel').hidden = false;
      $('invite-message').textContent = error.message;
    } finally { $('invite-submit').disabled = false; }
  }

  // Queue state stays in this page. Originals are never transformed in the browser.
  function addFiles(fileList) {
    if (state.config.uploadsOpen === false) return;
    const rejected = [];
    let added = 0;
    for (const file of Array.from(fileList)) {
      const extension = file.name.split('.').pop().toLowerCase();
      const mimeType = allowedMimes.has(file.type) ? file.type : mimeByExtension[extension];
      if (!mimeType) { rejected.push(`${file.name}: this file type isn’t supported.`); continue; }
      if (file.size > state.config.maxFileBytes) { rejected.push(`${file.name}: larger than ${bytes(state.config.maxFileBytes)}.`); continue; }
      if (!file.size) { rejected.push(`${file.name}: the file is empty.`); continue; }
      const signature = `${file.name}:${file.size}:${file.lastModified}`;
      if (state.jobs.some(job => job.signature === signature)) continue;
      const job = {file, mimeType, signature, uploadKey:crypto.randomUUID(), id:'', uploadToken:'', offset:0, displayOffset:0, phase:'ready', error:'', controller:null, paused:false, metadata:null, preview:'', statusNode:null, progressNode:null};
      if (['image/jpeg','image/png','image/webp','image/gif','image/avif'].includes(mimeType)) job.preview = URL.createObjectURL(file);
      state.jobs.push(job);
      added++;
    }
    $('file-input').value = '';
    renderQueue();
    $('upload-message').textContent = rejected.length ? rejected.join(' ') : (added ? `${added} ${added === 1 ? 'moment' : 'moments'} selected. Add a name or note, then share.` : 'These files are already in your list.');
  }
  function renderQueue() {
    const list = $('upload-list');
    list.replaceChildren();
    $('upload-fields').hidden = state.jobs.length === 0;
    for (const job of state.jobs) {
      const row = element('li', `upload-item${job.phase === 'done' ? ' is-done' : ''}${job.phase === 'error' ? ' is-error' : ''}`);
      let preview;
      if (job.preview) {
        preview = element('img', 'upload-preview');
        preview.src = job.preview;
        preview.alt = '';
      } else preview = element('span', 'upload-preview', job.mimeType.startsWith('video/') ? '▷' : '◇');
      const info = element('div');
      info.append(element('p', 'upload-file-name', job.file.name));
      let message = `${bytes(job.file.size)} · Ready to share`;
      if (job.phase === 'queued') message = 'Waiting to share…';
      const shownOffset = Math.max(job.offset, job.displayOffset || 0);
      if (job.phase === 'uploading') message = shownOffset >= job.file.size ? '100% · Finishing up…' : `${Math.floor(shownOffset / job.file.size * 100)}% · Sharing ${bytes(shownOffset)} of ${bytes(job.file.size)}`;
      if (job.phase === 'done') message = '✓ Shared with everyone';
      if (job.phase === 'paused') message = `Paused at ${Math.floor(job.offset / job.file.size * 100)}% · Resume when you’re ready`;
      if (job.phase === 'error') message = job.error;
      if (job.phase === 'retrying') message = 'Connection interrupted · Reconnecting…';
      job.statusNode = element('p', 'upload-status', message);
      info.append(job.statusNode);
      if (['uploading','retrying','paused'].includes(job.phase)) {
        const progress = element('progress', 'upload-progress');
        progress.max = job.file.size;
        progress.value = shownOffset;
        progress.setAttribute('aria-label', `${job.file.name} upload progress`);
        info.append(progress);
        job.progressNode = progress;
      } else {
        job.progressNode = null;
      }
      const actions = element('div','upload-item-actions');
      if (['uploading','retrying','queued'].includes(job.phase)) {
        const pause = element('button','text-button','Pause');
        pause.type = 'button';
        pause.addEventListener('click', () => { job.paused = true; job.phase = 'paused'; job.controller?.abort(); renderQueue(); });
        actions.append(pause);
      } else {
        if (['paused','error'].includes(job.phase)) {
          const retry = element('button','text-button',job.phase === 'paused' ? 'Resume' : 'Retry');
          retry.type = 'button';
          retry.addEventListener('click', () => { queueJob(job); processQueue(); });
          actions.append(retry);
        }
        const remove = element('button','text-button',job.phase === 'done' ? 'Clear' : 'Remove');
        remove.type = 'button';
        remove.setAttribute('aria-label', `${job.phase === 'done' ? 'Clear' : 'Remove'} ${job.file.name} from this list`);
        remove.addEventListener('click', () => removeJob(job));
        actions.append(remove);
      }
      row.append(preview, info, actions);
      list.append(row);
    }
    const pending = state.jobs.filter(job => ['ready','paused','error'].includes(job.phase)).length;
    $('start-upload').disabled = !pending || demo || state.config.uploadsOpen === false;
    $('start-upload').textContent = demo ? 'Preview only · uploads are off' : (pending ? `Share ${pending} ${pending === 1 ? 'moment' : 'moments'} ↑` : state.processing ? 'Sharing your moments…' : 'All moments shared ♡');
    $('clear-finished').hidden = !state.jobs.some(job => job.phase === 'done');
  }
  function removeJob(job) {
    if (job.preview) URL.revokeObjectURL(job.preview);
    state.jobs = state.jobs.filter(candidate => candidate !== job);
    if (job.id && job.phase !== 'done' && !demo) request(`/api/uploads/${encodeURIComponent(job.id)}`, {method:'DELETE',headers:{'X-Upload-Token':job.uploadToken}}).catch(() => {});
    renderQueue();
  }
  function queueJob(job) {
    job.phase = 'queued'; job.paused = false; job.error = '';
    if (!job.metadata) job.metadata = {guestName:$('guest-name').value.trim(), caption:$('caption').value.trim()};
    renderQueue();
  }
  function updateOffset(job, data) {
    if (!Number.isSafeInteger(data.offset) || data.offset < 0 || data.offset > job.file.size) throw apiError('The upload returned an unexpected position. Please retry.', 'INVALID_OFFSET', false);
    job.offset = data.offset;
    job.displayOffset = data.offset;
    if (data.complete) {
      if (data.offset !== job.file.size) throw apiError('The upload has not finished. Please retry.', 'INCOMPLETE_UPLOAD', false);
      job.phase = 'done';
    }
  }
  function uploadHeaders(job) { return {'X-Upload-Token':job.uploadToken}; }
  async function reconcile(job) {
    const data = await request(`/api/uploads/${encodeURIComponent(job.id)}`, {headers:uploadHeaders(job), signal:job.controller.signal});
    updateOffset(job, data);
  }
  async function uploadJob(job) {
    job.controller = new AbortController();
    job.phase = 'uploading';
    renderQueue();
    let failures = 0;
    let needsReconcile = Boolean(job.id);
    while (!job.paused && job.phase !== 'done') {
      try {
        if (!job.id) {
          const created = await request('/api/uploads', {method:'POST', headers:{'Content-Type':'application/json'}, signal:job.controller.signal, body:JSON.stringify({name:job.file.name,mimeType:job.mimeType,size:job.file.size,...job.metadata,uploadKey:job.uploadKey})});
          if (!created.id || !created.uploadToken) throw apiError('The upload could not be started. Please retry.', 'INVALID_UPLOAD', false);
          job.id = created.id; job.uploadToken = created.uploadToken;
          job.chunkBytes = Math.min(8388608, created.chunkBytes || state.config.chunkBytes);
          job.chunkBytes = Math.max(262144, Math.floor(job.chunkBytes / 262144) * 262144);
          updateOffset(job, created);
        }
        if (needsReconcile && job.phase !== 'done') { await reconcile(job); needsReconcile = false; }
        if (job.paused || job.phase === 'done') break;
        if (job.offset === job.file.size) {
          await reconcile(job);
          if (job.phase !== 'done') throw apiError('Your original is still being saved. Please retry in a moment.', 'FINALIZING', true);
          break;
        }
        job.phase = 'uploading';
        renderQueue();
        const start = job.offset;
        const end = Math.min(start + job.chunkBytes, job.file.size);
        const data = await uploadChunk(job, start, end);
        updateOffset(job, data);
        if (job.phase !== 'done' && job.offset <= start) throw apiError('The upload paused before this part was saved. Retrying…', 'NO_PROGRESS', true);
        failures = 0;
        renderQueue();
      } catch (error) {
        if (job.paused || error.name === 'AbortError') { job.phase = 'paused'; break; }
        // A lost response does not prove a lost chunk. Ask Drive for its position before sending more.
        needsReconcile = Boolean(job.id);
        if (!error.retryable || ++failures > 3) throw error;
        job.phase = 'retrying'; renderQueue();
        await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** (failures - 1), 5000)));
      }
    }
    if (job.paused && job.phase !== 'done') job.phase = 'paused';
    renderQueue();
  }
  async function processQueue() {
    if (state.processing || demo) return;
    state.processing = true;
    let shared = false;
    try {
      let job;
      while ((job = state.jobs.find(candidate => candidate.phase === 'queued'))) {
        try { await uploadJob(job); if (job.phase === 'done') shared = true; }
        catch (error) { job.phase = 'error'; job.error = `${error.message} You can retry here.`; renderQueue(); }
      }
    } finally { state.processing = false; renderQueue(); }
    const complete = state.jobs.filter(job => job.phase === 'done').length;
    const unfinished = state.jobs.some(job => job.phase !== 'done');
    $('upload-message').textContent = complete ? `${complete} ${complete === 1 ? 'moment' : 'moments'} shared. Thank you for being part of our day.${unfinished ? ' Some files still need your attention.' : ''}` : 'Your originals are still here. Resume or retry when you’re ready.';
    if (shared) await loadGallery(true);
  }

  function visibleItems() { return state.items.filter(item => state.filter === 'all' || (item.mimeType.startsWith('video/') ? 'video' : 'photo') === state.filter); }
  function placeholder(item, full = false) {
    const node = element('div', 'media-placeholder');
    node.append(element('span','placeholder-symbol',item.mimeType.startsWith('video/') ? '▷' : '◇'), element('p','',full ? 'This original may not preview in your browser. Download it to keep or view it.' : 'Original available'));
    return node;
  }
  function loadingIndicator() {
    const node = element('div', 'lightbox-loading');
    const spinner = element('span', 'lightbox-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    node.append(spinner, element('span', 'sr-only', 'Loading image'));
    return node;
  }
  function renderGallery() {
    const grid = $('gallery-grid');
    grid.replaceChildren();
    const items = visibleItems();
    items.forEach((item, index) => {
      const card = element('article','gallery-card');
      const open = element('button','gallery-open');
      open.type = 'button';
      const mediaType = item.mimeType.startsWith('video/') ? 'video' : 'photo';
      open.setAttribute('aria-label', `View ${mediaType}${item.caption ? `: ${item.caption}` : ''}${item.guestName ? ` from ${item.guestName}` : ''}`);
      const thumb = mediaURL(item.thumbnailUrl);
      if (thumb) {
        const img = element('img');
        img.src = thumb; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => img.replaceWith(placeholder(item)), {once:true});
        open.append(img);
      } else open.append(placeholder(item));
      if (item.mimeType.startsWith('video/')) open.append(element('span','gallery-type','▷ Video'));
      open.addEventListener('click', () => showViewer(index));
      card.append(open);
      if (item.caption) card.append(element('p','gallery-card-caption', item.caption));
      if (item.guestName) card.append(element('p','gallery-card-credit', `A moment from ${item.guestName}`));
      grid.append(card);
    });
    $('gallery-empty').hidden = items.length > 0 || state.galleryBusy;
    const filteredEmpty = state.items.length > 0 || state.filter !== 'all';
    $('gallery-empty-title').textContent = filteredEmpty ? `No ${state.filter === 'video' ? 'videos' : state.filter === 'photo' ? 'photos' : 'moments'} here yet.` : 'Every album starts with a moment.';
    $('gallery-empty-copy').textContent = state.cursor ? 'There may be more in the album. Load more moments below.' : filteredEmpty ? 'Your next favorite memory could be the first one shared.' : 'Be the first to share a little piece of our day.';
    $('load-more').hidden = !state.cursor;
    $('load-more').disabled = state.galleryBusy;
  }
  async function loadGallery(reset = false) {
    if (state.galleryBusy) return;
    if (demo) { renderGallery(); return; }
    state.galleryBusy = true;
    $('refresh-gallery').disabled = true;
    $('load-more').disabled = true;
    $('gallery-empty').hidden = true;
    $('gallery-message').classList.remove('is-error');
    $('gallery-message').textContent = 'Gathering the memories…';
    try {
      const params = new URLSearchParams({limit:'24'});
      if (!reset && state.cursor) params.set('cursor',state.cursor);
      const data = await request(`/api/gallery?${params}`);
      if (!Array.isArray(data.items)) throw apiError('The album could not be loaded. Please refresh.', 'INVALID_GALLERY', true);
      const clean = data.items.filter(item => item && typeof item.id === 'string' && typeof item.mimeType === 'string').map(item => ({...item,name:String(item.name || 'Wedding moment'),caption:String(item.caption || ''),guestName:String(item.guestName || '')}));
      const collection = reset ? clean : [...state.items, ...clean];
      state.items = [...new Map(collection.map(item => [item.id,item])).values()];
      state.cursor = typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null;
      $('gallery-message').textContent = state.items.length ? `${state.items.length} ${state.items.length === 1 ? 'moment' : 'moments'}${state.cursor ? ' loaded' : ' to remember'}` : '';
    } catch (error) {
      $('gallery-message').textContent = `${error.message} Tap Refresh to try again.`;
      $('gallery-message').classList.add('is-error');
    } finally {
      state.galleryBusy = false;
      $('refresh-gallery').disabled = false;
      renderGallery();
    }
  }
  function showViewer(index) {
    const items = visibleItems();
    if (!items.length) return;
    state.viewerIndex = (index + items.length) % items.length;
    const item = items[state.viewerIndex];
    const container = $('lightbox-media');
    const loadId = ++state.viewerLoad;
    container.querySelector('video')?.pause();
    container.replaceChildren();
    container.removeAttribute('aria-busy');
    const source = mediaURL(item.mediaUrl);
    const download = mediaURL(item.downloadUrl);
    if (source) {
      let media;
      if (item.mimeType.startsWith('video/')) {
        media = element('video'); media.controls = true; media.playsInline = true; media.preload = 'metadata';
        if (mediaURL(item.thumbnailUrl)) media.poster = mediaURL(item.thumbnailUrl);
        media.src = source;
        media.addEventListener('error',() => media.replaceWith(placeholder(item,true)),{once:true});
        container.append(media);
      } else {
        media = element('img'); media.alt = item.caption || 'Wedding photo'; media.referrerPolicy = 'no-referrer';
        container.setAttribute('aria-busy', 'true');
        container.append(loadingIndicator());
        const finish = node => {
          if (loadId !== state.viewerLoad) return;
          container.removeAttribute('aria-busy');
          container.replaceChildren(node);
        };
        media.addEventListener('load', () => finish(media), {once:true});
        media.addEventListener('error', () => finish(placeholder(item,true)), {once:true});
        media.src = source;
      }
    } else container.append(placeholder(item,true));
    $('lightbox-title').textContent = item.caption;
    $('lightbox-credit').textContent = item.guestName ? `A moment from ${item.guestName}` : '';
    $('lightbox-copy').hidden = !item.caption && !item.guestName;
    $('lightbox-position').textContent = `${state.viewerIndex + 1} of ${items.length}`;
    $('lightbox-download').hidden = !download;
    if (download) $('lightbox-download').href = download;
    $('lightbox-previous').hidden = items.length < 2;
    $('lightbox-next').hidden = items.length < 2;
    if (!$('lightbox').open) {
      $('lightbox').showModal();
      $('lightbox').focus({preventScroll:true});
      document.body.classList.add('has-lightbox');
    }
  }

  if ($('standalone-link')) $('standalone-link').href = location.href;
  $('invite-form').addEventListener('submit', event => { event.preventDefault(); const key = $('event-key').value.trim(); if (key) openAlbum(key); });
  $('choose-files').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', event => addFiles(event.target.files));
  let dragDepth = 0;
  $('drop-zone').addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; $('drop-zone').classList.add('is-dragging'); });
  $('drop-zone').addEventListener('dragover', event => event.preventDefault());
  $('drop-zone').addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) $('drop-zone').classList.remove('is-dragging'); });
  $('drop-zone').addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; $('drop-zone').classList.remove('is-dragging'); addFiles(event.dataTransfer.files); });
  $('start-upload').addEventListener('click', () => { if (demo) return; state.jobs.filter(job => ['ready','paused','error'].includes(job.phase)).forEach(queueJob); processQueue(); });
  $('clear-finished').addEventListener('click', () => state.jobs.filter(job => job.phase === 'done').forEach(removeJob));
  $('refresh-gallery').addEventListener('click', () => loadGallery(true));
  $('load-more').addEventListener('click', () => loadGallery(false));
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(filter => { filter.classList.toggle('is-active', filter === button); filter.setAttribute('aria-pressed',String(filter === button)); });
    renderGallery();
  }));
  $('lightbox-close').addEventListener('click', () => $('lightbox').close());
  $('lightbox').addEventListener('close', () => { state.viewerLoad++; $('lightbox-media').querySelector('video')?.pause(); $('lightbox-media').replaceChildren(); $('lightbox-media').removeAttribute('aria-busy'); document.body.classList.remove('has-lightbox'); });
  $('lightbox').addEventListener('click', event => { if (event.target === $('lightbox')) { const rect = $('lightbox').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('lightbox').close(); } });
  $('lightbox-previous').addEventListener('click', () => showViewer(state.viewerIndex - 1));
  $('lightbox-next').addEventListener('click', () => showViewer(state.viewerIndex + 1));
  $('lightbox').addEventListener('keydown', event => { if (event.target.tagName === 'VIDEO') return; if (event.key === 'ArrowLeft') { event.preventDefault(); showViewer(state.viewerIndex - 1); } if (event.key === 'ArrowRight') { event.preventDefault(); showViewer(state.viewerIndex + 1); } });
  window.addEventListener('beforeunload', event => { if (state.processing) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('hashchange', () => { const key = new URLSearchParams(location.hash.slice(1)).get('event'); if (key && key !== state.eventKey && !state.processing) openAlbum(key); });

  async function initialize() {
    if (demo) {
      $('preview-banner').hidden = false;
      $('invite-panel').hidden = true;
      $('guest-content').hidden = false;
      renderGallery();
      return;
    }
    try { applyConfig(await request('/api/config', {}, false)); }
    catch { notice('The album couldn’t connect just now. Please refresh the page in a moment.',true); }
    const key = readEvent();
    if (key) await openAlbum(key);
    else $('invite-panel').hidden = false;
  }
  initialize();
})();
