// End of Year Celebration 2026: photo & video share
const CFG = window.APP_CONFIG || {};
const API = String(CFG.WORKER_URL || '').trim().replace(/\/+$/, '');
const PART_SIZE = 20 * 1024 * 1024;           // must match worker.js
const MAX_PHOTO = 60 * 1024 * 1024;
const MAX_VIDEO = 600 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 60;
const PARALLEL_FILES = 2;
const POLL_MS = 45000;

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const state = {
  token: store.get('eoy.token'),
  role: store.get('eoy.role') || 'guest',
  items: [],
  usage: null,
  selecting: false,
  selected: new Set(),
  lb: -1,
  queue: [],
  active: 0,
  uploadedThisRound: 0,
  lastSig: '',
};

/* ---------------- basics ---------------- */

document.querySelectorAll('[data-title]').forEach(el => { el.textContent = CFG.EVENT_NAME || 'Photos'; });
document.querySelectorAll('[data-subtitle]').forEach(el => { el.textContent = CFG.EVENT_SUBTITLE || ''; });

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function fmtBytes(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
  if (n >= 1024 ** 2) return Math.round(n / 1024 ** 2) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}
function fmtDur(s) {
  if (!(s > 0)) return '';
  s = Math.round(s);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function isVideo(it) { return it.type.startsWith('video/') || ['mp4', 'mov', 'webm', '3gp', 'm4v'].includes(it.ext); }
function fileUrl(key, download) {
  return `${API}/api/file/${key}?t=${encodeURIComponent(state.token)}${download ? '&dl=1' : ''}`;
}
function thumbUrl(it) { return fileUrl(`t/${it.id}.jpg`); }

class AuthError extends Error {}

async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = {};
  if (state.token) headers.authorization = 'Bearer ' + state.token;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: payload });
  } catch {
    throw new Error('No connection. Check your signal and try again.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (res.status === 401 && path !== '/api/login') { signOut(); throw new AuthError(data?.error || 'Please enter the code again.'); }
  if (!res.ok) { const e = new Error(data?.error || `Server error (${res.status})`); e.status = res.status; throw e; }
  return data;
}

/* ---------------- code screen ---------------- */

function showGate(msg) {
  $('app').hidden = true;
  $('gate').hidden = false;
  $('gate-error').textContent = msg || '';
  setTimeout(() => $('code').focus(), 50);
}

function signOut() {
  state.token = null;
  store.del('eoy.token');
  store.del('eoy.role');
  closeLightbox();
  showGate('Please enter the event code again.');
}

$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('code').value;
  const btn = $('gate-btn');
  btn.disabled = true;
  $('gate-error').textContent = '';
  try {
    const r = await api('/api/login', { method: 'POST', body: { code } });
    state.token = r.token;
    state.role = r.role;
    store.set('eoy.token', r.token);
    store.set('eoy.role', r.role);
    $('code').value = '';
    showApp();
  } catch (err) {
    $('gate-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('btn-leave').addEventListener('click', () => {
  if (state.active || state.queue.length) { toast('Wait for your uploads to finish first.'); return; }
  state.token = null;
  store.del('eoy.token'); store.del('eoy.role');
  showGate('');
});

/* ---------------- gallery ---------------- */

function showApp() {
  $('gate').hidden = true;
  $('app').hidden = false;
  $('admin-badge').hidden = state.role !== 'admin';
  load(true);
}

async function load(first) {
  try {
    const r = await api('/api/list');
    state.items = r.items || [];
    state.usage = r.usage;
    if (r.role && r.role !== state.role) { state.role = r.role; store.set('eoy.role', r.role); $('admin-badge').hidden = r.role !== 'admin'; }
    render();
  } catch (err) {
    if (err instanceof AuthError) return;
    if (first) $('loading').textContent = err.message;
    else console.warn(err);
  }
}

function render() {
  $('loading').hidden = true;
  const items = state.items;
  $('empty').hidden = items.length > 0;
  const photos = items.filter(i => !isVideo(i)).length;
  const vids = items.length - photos;
  $('count').textContent = items.length
    ? `· ${photos} photo${photos === 1 ? '' : 's'}${vids ? `, ${vids} video${vids === 1 ? '' : 's'}` : ''}` : '';

  // usage
  const u = state.usage;
  if (u && u.limit) {
    const pct = Math.min(100, (u.used / u.limit) * 100);
    $('usage').hidden = false;
    $('usage-fill').style.width = pct + '%';
    $('usage-text').textContent = `${fmtBytes(u.used)} of ${fmtBytes(u.limit)} space used`;
    const full = u.used >= u.limit * 0.995;
    $('usage').classList.toggle('full', full);
    $('fab').disabled = full;
    $('fab').innerHTML = full ? 'Album full' : '<span class="plus">+</span> Add photos &amp; videos';
  }

  // only rebuild the grid if the list actually changed
  const sig = items.map(i => i.key + (i.thumb ? 1 : 0)).join('|');
  if (sig === state.lastSig) { refreshSelection(); return; }
  state.lastSig = sig;

  const grid = $('grid');
  const frag = document.createDocumentFragment();
  items.forEach((it, idx) => frag.appendChild(makeTile(it, idx)));
  grid.replaceChildren(frag);
  // drop selections of deleted items
  for (const k of [...state.selected]) if (!items.find(i => i.key === k)) state.selected.delete(k);
  refreshSelection();
}

function placeholder(it) {
  const d = document.createElement('div');
  d.className = 'ph';
  d.innerHTML = isVideo(it) ? '<span><b>▶</b>Video</span>' : `<span><b>▢</b>${(it.ext || 'photo').toUpperCase()}<br>tap to view</span>`;
  return d;
}

function makeTile(it, idx) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tile';
  b.dataset.key = it.key;
  b.setAttribute('aria-label', (isVideo(it) ? 'Video' : 'Photo') + (it.by ? ' by ' + it.by : ''));
  if (it.thumb) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.src = thumbUrl(it);
    img.onload = () => img.classList.add('loaded');
    img.onerror = () => { img.remove(); b.prepend(placeholder(it)); };
    b.appendChild(img);
  } else {
    b.appendChild(placeholder(it));
  }
  if (isVideo(it)) {
    const v = document.createElement('span');
    v.className = 'vid';
    v.textContent = '▶ ' + (fmtDur(it.dur) || 'Video');
    b.appendChild(v);
  }
  const c = document.createElement('span');
  c.className = 'check';
  c.textContent = '✓';
  b.appendChild(c);
  b.addEventListener('click', () => {
    if (state.selecting) toggleSelect(it.key);
    else openLightbox(state.items.findIndex(i => i.key === it.key));
  });
  return b;
}

// keep the gallery fresh while people are uploading
setInterval(() => {
  if (!state.token || document.hidden || state.lb >= 0 || $('app').hidden) return;
  load(false);
}, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.token && !$('app').hidden) load(false); });

/* ---------------- select mode ---------------- */

function setSelecting(on) {
  state.selecting = on;
  if (!on) state.selected.clear();
  document.body.classList.toggle('selecting', on);
  $('selectbar').hidden = !on;
  $('fab').hidden = on;
  $('btn-select').textContent = on ? 'Done' : 'Select';
  refreshSelection();
}
function toggleSelect(key) {
  state.selected.has(key) ? state.selected.delete(key) : state.selected.add(key);
  refreshSelection();
}
function refreshSelection() {
  document.querySelectorAll('.tile').forEach(t => t.classList.toggle('sel', state.selected.has(t.dataset.key)));
  const n = state.selected.size;
  const bytes = state.items.filter(i => state.selected.has(i.key)).reduce((s, i) => s + i.size, 0);
  $('sel-count').textContent = n ? `${n} selected · ${fmtBytes(bytes)}` : 'Tap to select';
  $('sel-dl').disabled = n === 0;
}
$('btn-select').addEventListener('click', () => setSelecting(!state.selecting));
$('sel-cancel').addEventListener('click', () => setSelecting(false));
$('sel-all').addEventListener('click', () => {
  if (state.selected.size === state.items.length) state.selected.clear();
  else state.items.forEach(i => state.selected.add(i.key));
  refreshSelection();
});
$('sel-dl').addEventListener('click', () => {
  const chosen = state.items.filter(i => state.selected.has(i.key));
  downloadItems(chosen, 'selected');
});
$('btn-dlall').addEventListener('click', () => {
  if (!state.items.length) { toast('Nothing to download yet.'); return; }
  const total = state.items.reduce((s, i) => s + i.size, 0);
  if (!confirm(`Download all ${state.items.length} items (${fmtBytes(total)})?\n\nOn a computer you'll get one zip. On a phone it comes in a few smaller zips.`)) return;
  downloadItems(state.items, 'all');
});

/* ---------------- viewer ---------------- */

function openLightbox(i) {
  if (i < 0) return;
  state.lb = i;
  $('lightbox').hidden = false;
  document.body.style.overflow = 'hidden';
  showLb();
}
function closeLightbox() {
  state.lb = -1;
  $('lightbox').hidden = true;
  $('lb-stage').replaceChildren();
  document.body.style.overflow = '';
}
function showLb() {
  const it = state.items[state.lb];
  if (!it) { closeLightbox(); return; }
  const stage = $('lb-stage');
  stage.replaceChildren();
  if (isVideo(it)) {
    const v = document.createElement('video');
    v.controls = true;
    v.playsInline = true;
    v.preload = 'metadata';
    if (it.thumb) v.poster = thumbUrl(it);
    v.src = fileUrl(it.key);
    v.onerror = () => {
      stage.replaceChildren(msg("This video can't play in this browser. Tap <b>Download</b> to watch it in your phone's video player."));
    };
    stage.appendChild(v);
  } else {
    const img = document.createElement('img');
    img.alt = it.name || 'Photo';
    if (it.thumb) img.src = thumbUrl(it); // instant preview, then swap to full quality
    const full = new Image();
    full.onload = () => { if (state.items[state.lb] === it) img.src = full.src; };
    full.onerror = () => {
      if (state.items[state.lb] !== it) return;
      if (!it.thumb) stage.replaceChildren(msg("This photo's format can't be shown in this browser. Tap <b>Download</b> to save it."));
    };
    full.src = fileUrl(it.key);
    stage.appendChild(img);
  }
  $('lb-pos').textContent = `${state.lb + 1} / ${state.items.length}`;
  $('lb-download').href = fileUrl(it.key, true);
  $('lb-delete').hidden = state.role !== 'admin';
  const when = new Date(it.uploaded);
  const parts = [];
  if (it.by) parts.push(`<b>${escapeHtml(it.by)}</b>`);
  parts.push(when.toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }));
  parts.push(fmtBytes(it.size));
  if (isVideo(it) && it.dur) parts.push(fmtDur(it.dur));
  $('lb-info').innerHTML = parts.join(' · ');
  $('lb-prev').disabled = state.lb === 0;
  $('lb-next').disabled = state.lb === state.items.length - 1;
}
function msg(html) { const d = document.createElement('div'); d.className = 'msg'; d.innerHTML = html; return d; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function step(d) {
  const n = state.lb + d;
  if (n < 0 || n >= state.items.length) return;
  state.lb = n;
  showLb();
}
$('lb-close').addEventListener('click', closeLightbox);
$('lb-prev').addEventListener('click', () => step(-1));
$('lb-next').addEventListener('click', () => step(1));
document.addEventListener('keydown', (e) => {
  if (state.lb < 0) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});
let touchX = null, touchY = null;
$('lb-stage').addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) { touchX = null; return; }
  touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
}, { passive: true });
$('lb-stage').addEventListener('touchend', (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  const dy = e.changedTouches[0].clientY - touchY;
  touchX = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  else if (dy > 120 && Math.abs(dy) > Math.abs(dx) * 1.5) closeLightbox();
}, { passive: true });
$('lb-delete').addEventListener('click', async () => {
  const it = state.items[state.lb];
  if (!it || !confirm('Delete this for everyone? This can\'t be undone.')) return;
  try {
    await api('/api/delete', { method: 'POST', body: { key: it.key } });
    state.items.splice(state.lb, 1);
    state.lastSig = '';
    render();
    if (!state.items.length) closeLightbox();
    else { state.lb = Math.min(state.lb, state.items.length - 1); showLb(); }
    toast('Deleted.');
  } catch (err) { toast(err.message); }
});

/* ---------------- adding photos ---------------- */

$('fab').addEventListener('click', () => {
  $('name').value = store.get('eoy.name') || '';
  $('add').hidden = false;
});
$('add-cancel').addEventListener('click', () => { $('add').hidden = true; });
$('add').addEventListener('click', (e) => { if (e.target === $('add')) $('add').hidden = true; });
$('add-choose').addEventListener('click', () => {
  store.set('eoy.name', $('name').value.trim());
  $('add').hidden = true;
  $('file-input').value = '';
  $('file-input').click();
});
$('file-input').addEventListener('change', () => {
  const files = [...$('file-input').files];
  if (files.length) enqueue(files);
});
$('up-close').addEventListener('click', () => { $('uploads').hidden = true; });

function enqueue(files) {
  $('uploads').hidden = false;
  if (!state.active && !state.queue.length) {
    $('up-list').replaceChildren();
    state.uploadedThisRound = 0;
  }
  for (const file of files) {
    const job = { file, li: makeUpRow(file) };
    state.queue.push(job);
  }
  updateUpTitle();
  pump();
}

function makeUpRow(file) {
  const li = document.createElement('li');
  li.className = 'up-item';
  li.innerHTML = `<span class="up-name"></span><span class="up-status">Waiting</span><div class="up-bar"><span></span></div>`;
  li.querySelector('.up-name').textContent = file.name || 'Photo';
  $('up-list').appendChild(li);
  return li;
}
function setRow(job, status, pct, cls) {
  job.li.querySelector('.up-status').textContent = status;
  if (pct !== undefined) job.li.querySelector('.up-bar span').style.width = Math.round(pct) + '%';
  job.li.classList.remove('done', 'failed');
  if (cls) job.li.classList.add(cls);
}
function updateUpTitle() {
  const left = state.queue.length + state.active;
  $('up-title').textContent = left ? `Uploading · ${left} to go` : `Done. ${state.uploadedThisRound} added`;
  $('up-warn').hidden = !left;
}

function pump() {
  while (state.active < PARALLEL_FILES && state.queue.length) {
    const job = state.queue.shift();
    state.active++;
    holdAwake(true);
    runJob(job).finally(() => {
      state.active--;
      updateUpTitle();
      if (state.active || state.queue.length) pump();
      else allDone();
    });
  }
  updateUpTitle();
}

async function runJob(job) {
  try {
    await uploadFile(job);
    state.uploadedThisRound++;
    setRow(job, 'Done ✓', 100, 'done');
  } catch (err) {
    if (err instanceof AuthError) { setRow(job, 'Stopped. Enter the code again', 0, 'failed'); return; }
    setRow(job, err.message || 'Failed', undefined, 'failed');
    if (!err.noRetry) {
      const r = document.createElement('button');
      r.type = 'button';
      r.className = 'btn ghost small up-retry';
      r.textContent = 'Try again';
      r.onclick = () => { r.remove(); setRow(job, 'Waiting', 0); state.queue.push(job); pump(); };
      job.li.appendChild(r);
    }
  }
}

function allDone() {
  holdAwake(false);
  updateUpTitle();
  if (state.uploadedThisRound) toast(`Added ${state.uploadedThisRound}. Thanks!`);
  load(false);
  setTimeout(() => { if (!state.active && !state.queue.length && !$('up-list').querySelector('.failed')) $('uploads').hidden = true; }, 5000);
}

function looksHeic(f) { return /\.(heic|heif)$/i.test(f.name) || /heic|heif/.test(f.type); }
function kindOfFile(f) {
  if (f.type.startsWith('video/') || /\.(mp4|mov|webm|3gp|m4v)$/i.test(f.name)) return 'video';
  if (f.type.startsWith('image/') || looksHeic(f) || /\.(jpe?g|png|webp|gif)$/i.test(f.name)) return 'image';
  return null;
}
function fail(message) { const e = new Error(message); e.noRetry = true; return e; }

async function uploadFile(job) {
  const f = job.file;
  const kind = kindOfFile(f);
  if (!kind) throw fail('Not a photo or video');
  if (kind === 'image' && f.size > MAX_PHOTO) throw fail('Too big (max 60 MB)');
  if (kind === 'video' && f.size > MAX_VIDEO) throw fail('Too big (max 600 MB)');

  setRow(job, 'Checking…', 0);
  let dur = null;
  if (kind === 'video') {
    dur = await videoDuration(f);
    if (dur && dur > MAX_VIDEO_SECONDS + 0.9) throw fail(`Too long (${fmtDur(dur)}). Max 60 seconds`);
  }

  setRow(job, 'Making preview…', 0);
  const thumb = await (kind === 'video' ? videoThumb(f) : imageThumb(f)).catch(() => null);

  let type = f.type;
  if (!type && looksHeic(f)) type = 'image/heic';

  const start = await api('/api/upload/start', {
    method: 'POST',
    body: { name: f.name || (kind === 'video' ? 'video.mp4' : 'photo.jpg'), type, size: f.size, by: store.get('eoy.name') || '', dur },
  });
  const job2 = { key: start.key, uploadId: start.uploadId };
  const partSize = start.partSize || PART_SIZE;
  const total = Math.max(1, Math.ceil(f.size / partSize));
  const parts = [];
  let doneBytes = 0;
  try {
    for (let n = 1; n <= total; n++) {
      const chunk = f.slice((n - 1) * partSize, n * partSize);
      const part = await withRetry(() => putPart(job2, n, chunk, (loaded) => {
        setRow(job, `${Math.round(((doneBytes + loaded) / f.size) * 100)}% · ${fmtBytes(f.size)}`, ((doneBytes + loaded) / f.size) * 97);
      }));
      parts.push(part);
      doneBytes += chunk.size;
    }
    setRow(job, 'Finishing…', 98);
    await withRetry(() => api('/api/upload/complete', { method: 'POST', body: { ...job2, parts } }));
  } catch (err) {
    api('/api/upload/abort', { method: 'POST', body: job2 }).catch(() => {});
    throw err;
  }
  if (thumb) {
    try { await api(`/api/thumb?id=${encodeURIComponent(start.id)}`, { method: 'PUT', raw: thumb }); } catch { /* preview is optional */ }
  }
}

function putPart(job2, n, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${API}/api/upload/part?key=${encodeURIComponent(job2.key)}&uploadId=${encodeURIComponent(job2.uploadId)}&n=${n}`);
    xhr.setRequestHeader('authorization', 'Bearer ' + state.token);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status === 401) { signOut(); reject(new AuthError('Code expired')); return; }
      if (xhr.status >= 200 && xhr.status < 300 && data && data.etag) resolve(data);
      else { const e = new Error(data?.error || `Upload error (${xhr.status})`); e.status = xhr.status; reject(e); }
    };
    xhr.onerror = () => reject(new Error('Connection dropped'));
    xhr.ontimeout = () => reject(new Error('Connection timed out'));
    xhr.timeout = 10 * 60 * 1000;
    xhr.send(blob);
  });
}

async function withRetry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (err) {
      last = err;
      if (err instanceof AuthError || (err.status && err.status >= 400 && err.status < 500)) throw err;
      await new Promise(r => setTimeout(r, [1000, 3000, 7000, 12000][i]));
    }
  }
  throw last;
}

/* previews made on the phone, so the gallery loads fast */

function canvasToJpeg(source, w, h) {
  const max = 640;
  const scale = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('no preview'))), 'image/jpeg', 0.8));
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function imageThumb(file) {
  return withTimeout((async () => {
    if (window.createImageBitmap) {
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        const out = await canvasToJpeg(bmp, bmp.width, bmp.height);
        bmp.close && bmp.close();
        return out;
      } catch { /* fall back to <img> */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      return await canvasToJpeg(img, img.naturalWidth, img.naturalHeight);
    } finally { URL.revokeObjectURL(url); }
  })(), 15000);
}

function loadVideo(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  const cleanup = () => { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); };
  return { v, cleanup };
}

async function videoDuration(file) {
  const { v, cleanup } = loadVideo(file);
  try {
    return await withTimeout(new Promise((res, rej) => {
      v.onloadedmetadata = () => res(isFinite(v.duration) ? v.duration : null);
      v.onerror = () => rej(new Error('bad video'));
    }), 10000);
  } catch { return null; } finally { cleanup(); }
}

async function videoThumb(file) {
  const { v, cleanup } = loadVideo(file);
  try {
    return await withTimeout(new Promise((res, rej) => {
      let drawn = false;
      const draw = () => {
        if (drawn || !v.videoWidth) return;
        drawn = true;
        try { v.pause(); } catch { /* ignore */ }
        canvasToJpeg(v, v.videoWidth, v.videoHeight).then(res, rej);
      };
      v.onerror = () => rej(new Error('bad video'));
      v.onloadedmetadata = () => { try { v.currentTime = Math.min(1, (v.duration || 2) / 2); } catch { /* ignore */ } };
      v.onseeked = draw;
      v.ontimeupdate = () => { if (v.currentTime > 0.3) draw(); };
      v.load();
      // iPhones won't decode a frame until the (muted) video starts playing
      const p = v.play && v.play();
      if (p && p.catch) p.catch(() => {});
    }), 12000);
  } finally { cleanup(); }
}

/* keep the screen on during uploads, and warn before leaving */
let wakeLock = null;
async function holdAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && (state.active || state.queue.length)) holdAwake(true); });
window.addEventListener('beforeunload', (e) => {
  if (state.active || state.queue.length) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------------- downloads ---------------- */

let dlAbort = null;
$('dl-cancel').addEventListener('click', () => { if (dlAbort) dlAbort.abort(); $('dl').hidden = true; });

function niceName(it, used) {
  const d = new Date(it.uploaded);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const by = (it.by || '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');
  let base = (it.name || `${it.id}.${it.ext}`).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_');
  if (!/\.[a-z0-9]{1,5}$/i.test(base)) base += '.' + it.ext;
  let name = [stamp, by, base].filter(Boolean).join('_');
  if (used.has(name.toLowerCase())) {
    const dot = name.lastIndexOf('.');
    let i = 2;
    while (used.has(`${name.slice(0, dot)}-${i}${name.slice(dot)}`.toLowerCase())) i++;
    name = `${name.slice(0, dot)}-${i}${name.slice(dot)}`;
  }
  used.add(name.toLowerCase());
  return name;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const isPhone = () => /iphone|ipad|ipod|android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /macintosh/i.test(navigator.userAgent));

async function downloadItems(items, label) {
  if (!items.length) return;
  if (items.length === 1) { window.location.href = fileUrl(items[0].key, true); return; }

  const zipBase = (CFG.EVENT_NAME || 'photos').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + (label === 'selected' ? '-selected' : '');
  const total = items.reduce((s, i) => s + i.size, 0);

  // Big desktop browsers (Chrome/Edge) can stream one zip straight to disk.
  let writable = null;
  if (!isPhone() && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: zipBase + '.zip', types: [{ description: 'Zip file', accept: { 'application/zip': ['.zip'] } }] });
      writable = await handle.createWritable();
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user cancelled
      writable = null;
    }
  }

  const { downloadZip } = await import('./vendor/client-zip.js');
  dlAbort = new AbortController();
  const signal = dlAbort.signal;
  $('dl').hidden = false;
  $('dl-fill').style.width = '0%';
  let doneBytes = 0, doneCount = 0;
  const used = new Set();
  const progress = () => {
    $('dl-text').textContent = `${doneCount} of ${items.length} · ${fmtBytes(doneBytes)} of ${fmtBytes(total)}`;
    $('dl-fill').style.width = Math.min(100, (doneBytes / total) * 100) + '%';
  };
  async function* files(list) {
    for (const it of list) {
      if (signal.aborted) return;
      let res;
      try { res = await fetch(fileUrl(it.key), { signal }); } catch (e) { if (signal.aborted) return; continue; }
      if (!res.ok) continue;
      // count bytes as they stream through
      const reader = res.body.getReader();
      const counted = new ReadableStream({
        async pull(ctrl) {
          const { done, value } = await reader.read();
          if (done) { doneCount++; progress(); ctrl.close(); return; }
          doneBytes += value.byteLength; progress(); ctrl.enqueue(value);
        },
        cancel(r) { reader.cancel(r); },
      });
      yield { name: niceName(it, used), lastModified: new Date(it.uploaded), input: counted, size: it.size };
    }
  }

  try {
    progress();
    if (writable) {
      await downloadZip(files(items)).body.pipeTo(writable, { signal });
      if (!signal.aborted) toast('Download finished.');
    } else {
      // Split into batches the phone/browser can hold in memory.
      const limit = isPhone() ? 350 * 1024 * 1024 : 1500 * 1024 * 1024;
      const batches = [];
      let cur = [], curSize = 0;
      for (const it of items) {
        if (cur.length && curSize + it.size > limit) { batches.push(cur); cur = []; curSize = 0; }
        cur.push(it); curSize += it.size;
      }
      if (cur.length) batches.push(cur);
      for (let b = 0; b < batches.length; b++) {
        if (signal.aborted) break;
        const blob = await downloadZip(files(batches[b])).blob();
        if (signal.aborted) break;
        const suffix = batches.length > 1 ? `-part-${b + 1}-of-${batches.length}` : '';
        saveBlob(blob, `${zipBase}${suffix}.zip`);
        if (b < batches.length - 1) await new Promise(r => setTimeout(r, 1500));
      }
      if (!signal.aborted) toast(batches.length > 1 ? `Saved ${batches.length} zip files.` : 'Download ready.');
    }
  } catch (err) {
    if (!signal.aborted) toast('Download stopped: ' + (err.message || 'error'));
  } finally {
    $('dl').hidden = true;
    dlAbort = null;
    if (state.selecting && label === 'selected') setSelecting(false);
  }
}

/* ---------------- share ---------------- */

function siteUrl() { return location.origin + location.pathname.replace(/index\.html$/, ''); }

$('btn-share').addEventListener('click', () => {
  const url = siteUrl();
  $('share-link').textContent = url;
  $('share-sign').href = 'sign.html?u=' + encodeURIComponent(url);
  $('share-native').hidden = !navigator.share;
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch { $('qr').textContent = ''; }
  $('share').hidden = false;
});
$('share-close').addEventListener('click', () => { $('share').hidden = true; });
$('share').addEventListener('click', (e) => { if (e.target === $('share')) $('share').hidden = true; });
$('share-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(siteUrl()); toast('Link copied.'); }
  catch { toast('Couldn\'t copy. Press and hold the link to copy it.'); }
});
$('share-native').addEventListener('click', async () => {
  try { await navigator.share({ title: CFG.EVENT_NAME, text: `Photos & videos from the ${CFG.EVENT_NAME}. Add yours!`, url: siteUrl() }); } catch { /* cancelled */ }
});

/* ---------------- start ---------------- */

if (!API || /PASTE-YOUR/.test(API)) {
  showGate('This site isn\'t connected yet. Put the Worker address in config.js.');
  $('gate-form').hidden = true;
} else if (state.token) {
  showApp();
} else {
  showGate('');
}
