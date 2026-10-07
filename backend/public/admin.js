'use strict';
const $ = id => document.getElementById(id);
let status = null, cursor = null;
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error?.message || 'Please try again.'); error.status = response.status; throw error; }
  return data;
}
function message(text) { $('message').textContent = text; }
async function run(action) { try { message(''); await action(); } catch (error) { message(error.message); } }
function line(label, value) { const p = document.createElement('p'); const b = document.createElement('strong'); b.textContent = label + ': '; p.append(b, String(value)); return p; }
async function refresh() {
  try { status = await api('/api/admin/status'); }
  catch (error) { if (error.status === 401) { $('login').hidden = false; $('controls').hidden = true; return; } throw error; }
  $('login').hidden = true; $('controls').hidden = false;
  $('status').replaceChildren(line('Google Drive', status.connected ? 'Connected' : 'Not connected'), line('Guest uploads', status.uploadsOpen ? 'Open' : 'Paused'), line('Originals collected', (status.usedBytes / 1073741824).toFixed(2) + ' GB'), line('Uploads in progress', status.activeUploads));
  if (status.connectedAt) $('status').append(line('Last connected', new Date(status.connectedAt).toLocaleString()));
  if (status.connectionError) $('status').append(line('Connection needs attention', status.connectionError));
  if (status.quota?.limit) $('status').append(line('Drive space remaining', ((Number(status.quota.limit) - Number(status.quota.usage || 0)) / 1073741824).toFixed(1) + ' GB'));
  $('setup').hidden = status.oauthConfigured; $('callback').textContent = status.oauthCallbackUrl;
  $('connect').disabled = !status.oauthConfigured; $('connect').textContent = status.connected ? 'Reconnect Google Drive' : 'Connect Google Drive';
  $('toggle').disabled = !status.connected; $('toggle').textContent = status.uploadsOpen ? 'Pause uploads' : 'Open uploads';
  $('invite').href = status.invitationUrl; $('invite').textContent = status.invitationUrl;
  $('folder').hidden = !status.folderUrl; if (status.folderUrl) $('folder').href = status.folderUrl;
  await loadGallery(true);
}
async function loadGallery(reset = false) {
  if (reset) { cursor = null; $('gallery').replaceChildren(); }
  const result = await api('/api/admin/gallery' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
  for (const item of result.items) {
    const row = document.createElement('div'); row.className = 'item';
    const text = document.createElement('p'); text.textContent = item.name;
    const small = document.createElement('small'); small.textContent = `${item.guestName || 'A wedding guest'} · ${item.hidden ? 'Hidden' : 'Visible to guests'}`; text.append(small);
    const button = document.createElement('button'); button.className = 'secondary'; button.textContent = item.hidden ? 'Show in album' : 'Hide from album';
    button.addEventListener('click', () => run(async () => { button.disabled = true; await api('/api/admin/media/' + item.id, { method: 'POST', body: JSON.stringify({ hidden: !item.hidden }) }); await loadGallery(true); }));
    row.append(text, button); $('gallery').append(row);
  }
  cursor = result.nextCursor; $('more').hidden = !cursor;
  if (!$('gallery').children.length) $('gallery').textContent = 'The album is waiting for its first memory.';
}
async function login(key) { await api('/api/admin/session', { method: 'POST', body: JSON.stringify({ adminKey: key }) }); $('key').value = ''; await refresh(); }
$('login').addEventListener('submit', event => { event.preventDefault(); run(() => login($('key').value)); });
$('refresh').addEventListener('click', () => run(refresh));
$('connect').addEventListener('click', () => run(async () => { const { url } = await api('/api/admin/oauth/start', { method: 'POST', body: '{}' }); location.assign(url); }));
$('toggle').addEventListener('click', () => run(async () => { await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ uploadsOpen: !status.uploadsOpen }) }); await refresh(); }));
$('copy').addEventListener('click', () => run(async () => { await navigator.clipboard.writeText(status.invitationUrl); message('Guest link copied.'); }));
$('more').addEventListener('click', () => run(() => loadGallery()));
$('logout').addEventListener('click', () => run(async () => { await api('/api/admin/logout', { method: 'POST', body: '{}' }); location.reload(); }));
const fragment = new URLSearchParams(location.hash.slice(1)); const key = fragment.get('key');
history.replaceState(null, '', location.pathname);
run(async () => { if (key) await login(key); else await refresh(); if (fragment.get('connection') === 'success') message('Google Drive connected. You can now open guest uploads.'); });
