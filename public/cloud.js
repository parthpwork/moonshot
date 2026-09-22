import { splitWorkspace, joinWorkspace, equal } from './record-model.js';
const CACHE = 'moonshot.cloud.v2';
const OLD_CACHE = 'moonshot.workspace.v1';
const clone = value => JSON.parse(JSON.stringify(value));
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
export class SyncStore {
  constructor({ request, persist, onChange = () => {} }) {
    this.request = request; this.persist = persist; this.onChange = onChange;
    this.records = {}; this.pending = {}; this.inFlight = null; this.conflicts = {};
    this.busy = false; this.error = ''; this.cacheError = false; this.lastSaved = '';
  }
  restore(value) {
    if (value?.version === 2 && value.records && value.pending) {
      this.records = value.records; this.pending = value.pending; this.inFlight = value.inFlight || null;
      this.lastSaved = value.lastSaved || '';
    }
  }
  checkpoint() {
    try { this.persist({ version:2, records:this.records, pending:this.pending, inFlight:this.inFlight, lastSaved:this.lastSaved }); this.cacheError = false; }
    catch { this.cacheError = true; }
    this.onChange();
  }
  visible() {
    const result = Object.fromEntries(Object.entries(this.records).map(([k, v]) => [k, v.data]));
    for (const [key, item] of Object.entries(this.pending)) result[key] = item.data;
    return clone(result);
  }
  queue(values) {
    const current = this.visible();
    for (const key of new Set([...Object.keys(current), ...Object.keys(values)])) {
      const data = values[key] ?? null;
      if (!equal(data, current[key])) this.pending[key] = { key, data:clone(data), revision:this.records[key]?.revision || 0, operationId:crypto.randomUUID() };
    }
    this.checkpoint();
  }
  acknowledge(record, sent) {
    this.records[record.key] = record;
    const pending = this.pending[record.key];
    if (pending?.operationId === sent.operationId) delete this.pending[record.key];
    else if (pending) pending.revision = record.revision;
    if (this.inFlight?.operationId === sent.operationId) this.inFlight = null;
    this.lastSaved = record.updated_at || new Date().toISOString();
    delete this.conflicts[record.key];
  }
  reconcile(remote) {
    for (const record of remote) {
      if (this.inFlight?.key === record.key && record.operation_id === this.inFlight.operationId) this.acknowledge(record, this.inFlight);
      const pending = this.pending[record.key];
      if (pending && record.revision !== pending.revision) {
        if (equal(pending.data, record.data) && this.inFlight?.key !== record.key) {
          delete this.pending[record.key]; this.records[record.key] = record;
        } else this.conflicts[record.key] = record;
      } else this.records[record.key] = record;
    }
    this.checkpoint();
  }
  async flush() {
    if (this.busy || Object.keys(this.conflicts).length) return;
    this.busy = true; this.error = ''; this.onChange();
    try {
      while (this.inFlight || Object.keys(this.pending).length) {
        const sent = this.inFlight || clone(Object.values(this.pending)[0]);
        this.inFlight = sent; this.checkpoint();
        const response = await this.request(sent);
        if (response.status === 409) {
          this.conflicts[sent.key] = response.body.record;
          this.error = 'An entry changed on another device. Both copies have been kept.';
          break;
        }
        if (response.status !== 200) { this.loginRequired = response.status === 401; throw new Error(response.body.error || 'Cloud saving is unavailable. Retrying soon.'); }
        this.loginRequired = false;
        this.acknowledge(response.body.record, sent);
        this.checkpoint();
      }
    } catch (error) { this.error = error.message; }
    finally { this.busy = false; this.checkpoint(); }
  }
  chooseRemote() {
    for (const [key, record] of Object.entries(this.conflicts)) {
      if (record) this.records[key] = record;
      else delete this.records[key];
      delete this.pending[key];
      if (this.inFlight?.key === key) this.inFlight = null;
    }
    this.conflicts = {}; this.error = ''; this.checkpoint();
  }
}
let store, helpers, activeState, timer, pollBusy = false, legacy = null, activeUserId = '', activeCache = '';
let initialized = false;
function gate(title, subtitle, body = '') {
  let root = document.querySelector('#cloud-gate');
  if (!root) { root = document.createElement('div'); root.id = 'cloud-gate'; root.className = 'cloud-gate'; document.body.append(root); }
  root.innerHTML = `<section class="cloud-panel"><div class="cloud-mark">☾</div><div class="eyebrow">YOUR PERSONAL PURSUIT</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p>${body}</section>`;
  return root;
}
async function request(url, options = {}) {
  const response = await fetch(url, { cache:'no-store', credentials:'same-origin', ...options, headers:{ 'Content-Type':'application/json', ...(options.headers || {}) }, signal:AbortSignal.timeout(20000) });
  let body;
  try { body = await response.json(); } catch { body = { error:'The server could not be reached. Your device copy has been kept.' }; }
  return { status:response.status, body };
}
async function authenticate() {
  gate('Opening Moonshot', 'Connecting to your private workspace.', '<div class="cloud-spinner"></div>');
  let response;
  try { response = await request('/api/session'); } catch { response = { status:503, body:{ error:'Could not connect. Check your connection and try again.' } }; }
  if (response.status !== 200) {
    const root = gate('Your workspace is safe', response.body.error || 'Cloud saving is not configured yet.', '<button class="btn primary full" id="cloud-retry">Try again</button>');
    await new Promise(resolve => root.querySelector('#cloud-retry').onclick = resolve);
    return authenticate();
  }
  if (response.body.authenticated) return response.body.user;
  return new Promise(resolve => {
    let mode = 'login';
    const draw = () => {
      const registering = mode === 'register';
      const root = gate(registering ? 'Create your account.' : 'Welcome back.', registering ? 'Create a private workspace for your own plans and journals.' : 'Sign in to restore your plans, journals, and progress.', `<form id="cloud-login"><label>Username<input class="input" name="username" type="text" required minlength="6" maxlength="64" autocomplete="username" autocapitalize="none" spellcheck="false"></label><label>${registering?'Create a password':'Password'}<input class="input" name="password" type="password" required minlength="6" maxlength="256" autocomplete="${registering?'new-password':'current-password'}"></label><p class="cloud-help">Username and password must each be at least 6 characters.</p><p class="cloud-error" role="alert"></p><button class="btn primary full" type="submit">${registering?'Create account':'Sign in'}</button><button class="cloud-account-switch" type="button">${registering?'Already have an account? Sign in':'New to Moonshot? Create an account'}</button></form>`);
      root.querySelector('.cloud-account-switch').onclick = () => { mode = registering ? 'login' : 'register'; draw(); };
      root.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector('[type="submit"]'); button.disabled = true;
        try {
          const data = Object.fromEntries(new FormData(form)); data.action = mode;
          const result = await request('/api/session', { method:'POST', body:JSON.stringify(data) });
          if (result.status !== 200) throw new Error(result.body.error);
          form.reset(); resolve(result.body.user);
        } catch (error) { form.querySelector('.cloud-error').textContent = error.message; }
        finally { button.disabled = false; }
      };
    };
    draw();
  });
}
async function readRemote() {
  const result = []; let cursor = '';
  do {
    const response = await request(`/api/workspace?cursor=${encodeURIComponent(cursor)}`);
    if (response.status !== 200) throw Object.assign(new Error(response.body.error || 'Could not load your workspace.'), {status:response.status});
    const rows = response.body.records;
    if (!Array.isArray(rows)) throw new Error('The cloud response was invalid.');
    result.push(...rows);
    const next = response.body.cursor;
    if (!next) break;
    if (next === cursor) throw new Error('Cloud loading stopped safely. Please reload.');
    cursor = next;
  } while (true);
  return result;
}
function assembled() {
  const data = joinWorkspace(store.visible(), helpers.empty);
  data.updatedAt = store.lastSaved || new Date().toISOString();
  return helpers.normalize(data);
}
function refreshApp() { activeState = assembled(); cloud.onRemote?.(activeState); }
function backup(data, suffix) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `moonshot-${suffix}-${new Date().toISOString().slice(0,10)}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function openLocked(options) {
  helpers = options;
  const user = await authenticate();
  activeUserId = String(user.id);
  activeCache = `${CACHE}.user.${activeUserId}`;
  gate('Bringing your days back', 'Loading your saved workspace.', '<div class="cloud-spinner"></div>');
  try {
    if (activeUserId === '1' && !localStorage.getItem(activeCache) && localStorage.getItem(CACHE)) {
      localStorage.setItem(activeCache, localStorage.getItem(CACHE));
      localStorage.removeItem(CACHE);
    }
  } catch {}
  store = new SyncStore({ request:packet => request('/api/workspace', { method:'PUT', body:JSON.stringify(packet) }), persist:value => localStorage.setItem(activeCache, JSON.stringify(value)), onChange:() => cloud.paint() });
  let badCache = '';
  try { const raw = localStorage.getItem(activeCache); if (raw) { badCache = raw; store.restore(JSON.parse(raw)); badCache = ''; } } catch { /* Handle recoverable cache below. */ }
  if (badCache) {
    const root = gate('A device copy needs attention', 'Download this recovery copy before loading your cloud data. The unreadable copy will remain on this device.', '<button class="btn primary full" id="cloud-recover">Download recovery & continue</button>');
    await new Promise(resolve => root.querySelector('button').onclick = () => { backup({ raw:badCache }, 'device-recovery'); try { localStorage.setItem(`${activeCache}.recovery`, badCache); } catch {} resolve(); });
  }
  while (true) {
    try { store.reconcile(await readRemote()); break; }
    catch (error) {
      const root = gate('Could not load cloud data', error.message, '<button class="btn primary full" id="cloud-retry-load">Try again</button>');
      await new Promise(resolve => root.querySelector('button').onclick = resolve);
    }
  }
  if (!Object.keys(store.visible()).length) store.queue(splitWorkspace(helpers.empty()));
  try { const raw = localStorage.getItem(OLD_CACHE); if (raw) legacy = helpers.normalize(JSON.parse(raw)); } catch {}
  activeState = assembled(); initialized = true;
  document.querySelector('#cloud-gate')?.remove();
  setInterval(() => { if (Object.keys(store.pending).length || store.inFlight) store.flush(); else poll(); }, 12000);
  window.addEventListener('online', () => { store.flush().then(poll); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.flush(); else poll(); });
  window.addEventListener('beforeunload', event => { if (Object.keys(store.pending).length || store.inFlight) { event.preventDefault(); event.returnValue = ''; } });
  store.flush();
  return activeState;
}
async function poll() {
  if (!initialized || pollBusy || store.busy || document.visibilityState === 'hidden') return;
  pollBusy = true;
  try {
    const before = JSON.stringify(store.visible());
    store.reconcile(await readRemote());
    if (before !== JSON.stringify(store.visible())) {
      refreshApp();
    }
  } catch (error) { store.error = error.message; store.loginRequired = error.status === 401; store.onChange(); }
  finally { pollBusy = false; }
}
export const cloud = {
  onRemote:null,
  async open(options) {
    if (!navigator.locks) {
      gate('Update your browser', 'Moonshot needs a current browser with Web Locks to protect drafts in multiple tabs.');
      return new Promise(() => {});
    }
    return new Promise((resolve, reject) => navigator.locks.request('moonshot-private-editor', { ifAvailable:true }, async lock => {
      if (!lock) {
        const root = gate('Moonshot is already open', 'Close the other Moonshot tab before editing here. This keeps your unsaved drafts safe.', '<button class="btn primary full">Try again</button>');
        root.querySelector('button').onclick = () => location.reload(); return;
      }
      try { resolve(await openLocked(options)); } catch (error) { reject(error); }
      await new Promise(() => {});
    }).catch(reject));
  },
  save(state) {
    activeState = state;
    store.queue(splitWorkspace(state));
    clearTimeout(timer); timer = setTimeout(() => store.flush(), 800);
    return !store.cacheError;
  },
  paint() {
    if (!store) return;
    const conflicts = Object.keys(store.conflicts);
    const pending = Object.keys(store.pending).length;
    let label = conflicts.length ? 'Conflict · copies kept' : store.error ? 'Not synced · retrying' : pending || store.inFlight ? 'Saving to cloud…' : 'Saved to cloud';
    if (store.cacheError) label = pending ? 'Draft not saved · keep tab open' : 'Saved to cloud · device storage full';
    const indicator = document.querySelector('#save-indicator');
    if (indicator) { indicator.classList.toggle('error', !!(store.error || conflicts.length || store.cacheError)); indicator.title = store.lastSaved ? `Last cloud save: ${new Date(store.lastSaved).toLocaleString()}` : 'Waiting for the first confirmed cloud save'; indicator.innerHTML = `<i class="dot"></i><span>${escapeHtml(label)}</span>`; }
    let banner = document.querySelector('#cloud-message');
    if (!banner && document.querySelector('.topbar')) { banner = document.createElement('div'); banner.id = 'cloud-message'; banner.className = 'cloud-message'; document.querySelector('.topbar').after(banner); }
    if (!banner) return;
    if (conflicts.length) {
      banner.innerHTML = '<span><strong>This entry changed on another device.</strong> Your edits are kept here. Download them before loading the cloud version.</span><button class="btn secondary" id="cloud-conflict-download">Download my edits & load cloud version</button>';
      banner.querySelector('button').onclick = () => { backup(activeState, 'conflict-copy'); store.chooseRemote(); refreshApp(); store.flush(); };
    } else if (store.cacheError || store.error) {
      banner.innerHTML = `<span>${escapeHtml(store.cacheError ? 'Device storage is full. Keep this tab open until cloud saving finishes, or download a backup.' : store.error)}</span><button class="btn secondary" id="cloud-export-now">Download backup</button><button class="btn secondary" id="cloud-retry-now">Retry</button>`;
      banner.querySelector('#cloud-export-now').onclick = () => backup(activeState, 'recovery');
      banner.querySelector('#cloud-retry-now').textContent = store.loginRequired ? 'Sign in again' : 'Retry';
      banner.querySelector('#cloud-retry-now').onclick = async () => { if(store.loginRequired){const user=await authenticate();if(String(user.id)!==activeUserId){location.reload();return;}document.querySelector('#cloud-gate')?.remove();} await store.flush();await poll(); };
    } else if (legacy) {
      banner.innerHTML = '<span>An older Moonshot workspace was found on this device.</span><button class="btn secondary" id="cloud-legacy-export">Download older workspace</button><button class="btn secondary" id="cloud-legacy-hide">Dismiss</button>';
      banner.querySelector('#cloud-legacy-export').onclick = () => backup(legacy, 'previous-device');
      banner.querySelector('#cloud-legacy-hide').onclick = () => { legacy = null; cloud.paint(); };
    } else banner.innerHTML = '';
  },
  async signOut() {
    await store.flush();
    if (Object.keys(store.pending).length || store.inFlight || Object.keys(store.conflicts).length) { alert('Wait for cloud saving to finish or resolve the conflict before signing out. Download a backup if the connection is unavailable.'); return; }
    const response = await request('/api/session', { method:'POST', body:JSON.stringify({ action:'logout' }) });
    if (response.status === 200) { localStorage.removeItem(activeCache); location.reload(); }
    else alert(response.body.error || 'Could not sign out.');
  },
  async downloadHistory() {
    const key = prompt('Which entry? Enter a date (YYYY-MM-DD), profile, or settings.');
    if (!key) return;
    const recordKey = /^\d{4}-\d{2}-\d{2}$/.test(key) ? `day:${key}` : key;
    const response = await request(`/api/history?key=${encodeURIComponent(recordKey)}`);
    if (response.status !== 200) { alert(response.body.error); return; }
    if (!response.body.records.length) { alert('No earlier version has been recorded for that entry yet.'); return; }
    const chosen = prompt(`Enter a version number to download:\n${response.body.records.map((r,i) => `${i+1}. ${r.hour}`).join('\n')}`);
    const index = Number(chosen) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= response.body.records.length) return;
    const row = response.body.records[index];
    const result = await request(`/api/history?key=${encodeURIComponent(recordKey)}&hour=${encodeURIComponent(row.hour)}`);
    if (result.status !== 200 || !result.body.records.length) { alert('That version could not be loaded.'); return; }
    const records = store.visible(); records[recordKey] = result.body.records[0].data;
    backup(helpers.normalize(joinWorkspace(records, helpers.empty)), 'history-recovery');
  }
};
