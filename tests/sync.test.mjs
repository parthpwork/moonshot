import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncStore } from '../public/cloud.js';
import { splitWorkspace, joinWorkspace } from '../public/record-model.js';
const copy = value => JSON.parse(JSON.stringify(value));
function server() {
  const records = {};
  return { records, async request(packet) {
    const old = records[packet.key];
    if (old?.operation_id === packet.operationId) return { status:200, body:{ record:copy(old) } };
    if ((old?.revision || 0) !== packet.revision) return { status:409, body:{ record:copy(old || null) } };
    const record = { key:packet.key, data:copy(packet.data), revision:(old?.revision || 0)+1, operation_id:packet.operationId, updated_at:new Date().toISOString() };
    records[packet.key] = record;
    return { status:200, body:{ record:copy(record) } };
  } };
}
test('cloud state survives a new client with no browser cache', async () => {
  const backend = server();
  const first = new SyncStore({ request:backend.request, persist:() => {} });
  first.queue({ profile:{name:'Parth'}, 'day:2026-09-22':{journal:{thoughts:'A private journal'}} });
  await first.flush();
  const second = new SyncStore({ request:backend.request, persist:() => {} });
  second.reconcile(Object.values(backend.records));
  assert.deepEqual(second.visible(), first.visible());
  assert.equal(Object.keys(first.pending).length, 0);
});
test('lost acknowledgement is safely retried after reload without a duplicate revision', async () => {
  const backend = server(); let cached;
  const first = new SyncStore({ persist:v => cached = copy(v), request:async p => { await backend.request(p); throw new Error('Connection lost after save'); } });
  first.queue({ profile:{name:'Saved despite lost response'} }); await first.flush();
  assert.ok(cached.inFlight);
  const second = new SyncStore({ persist:() => {}, request:backend.request }); second.restore(cached);
  second.reconcile(Object.values(backend.records)); await second.flush();
  assert.equal(backend.records.profile.revision, 1);
  assert.equal(second.inFlight, null);
  assert.deepEqual(second.pending, {});
});
test('typing during a slow save keeps and then saves the latest draft', async () => {
  const backend = server(); let release, calls = 0;
  const store = new SyncStore({ persist:() => {}, request:async p => { if (++calls === 1) await new Promise(r => release = r); return backend.request(p); } });
  store.queue({ profile:{name:'First'} });
  const saving = store.flush();
  store.queue({ profile:{name:'Latest'} });
  release(); await saving;
  assert.equal(backend.records.profile.data.name, 'Latest');
  assert.equal(backend.records.profile.revision, 2);
  assert.deepEqual(store.pending, {});
});
test('same-entry concurrent changes never silently overwrite one another', async () => {
  const backend = server(); const create = () => new SyncStore({ request:backend.request, persist:() => {} });
  const a = create(), b = create();
  a.queue({ profile:{name:'Initial'} }); await a.flush();
  b.reconcile(Object.values(backend.records));
  a.queue({ profile:{name:'Cloud edit'} }); await a.flush();
  b.queue({ profile:{name:'Offline edit'} }); await b.flush();
  assert.equal(b.visible().profile.name, 'Offline edit');
  assert.equal(backend.records.profile.data.name, 'Cloud edit');
  assert.ok(b.conflicts.profile);
  b.chooseRemote(); assert.equal(b.visible().profile.name, 'Cloud edit');
});
test('independent days from two devices can both save', async () => {
  const backend = server(); const a = new SyncStore({ request:backend.request, persist:() => {} }); const b = new SyncStore({ request:backend.request, persist:() => {} });
  a.queue({ 'day:2026-09-22':{text:'one'} }); b.queue({ 'day:2026-09-23':{text:'two'} });
  await Promise.all([a.flush(), b.flush()]);
  a.reconcile(Object.values(backend.records));
  assert.equal(Object.keys(a.visible()).length, 2);
});
test('deleted entries synchronize as tombstones and device quota failures do not prevent cloud saves', async () => {
  const backend = server(); const a = new SyncStore({ request:backend.request, persist:() => { throw new Error('quota'); } });
  a.queue({ profile:{name:'Kept'}, 'day:2026-09-22':{text:'remove'} }); await a.flush();
  a.queue({ profile:{name:'Kept'} }); await a.flush();
  assert.equal(backend.records['day:2026-09-22'].data, null);
  assert.equal(a.cacheError, true); assert.equal(Object.keys(a.pending).length, 0);
});
test('workspace split and join preserve all original feature data', () => {
  const empty = () => ({ version:1, createdAt:'2026-09-22', profile:{}, anchors:[], days:{}, weeks:{}, sessions:[], settings:{}, timer:null });
  const original = { ...empty(), profile:{name:'Parth',goal:'Build'}, anchors:[{id:'move'}], days:{'2026-09-22':{journal:{thoughts:'x'},revisions:[{reason:'changed'}],tasks:[{id:'one'}]}}, weeks:{'2026-09-21':{direction:'Focus'}}, sessions:[{id:'abc',endedAt:'2026-09-22T12:00:00Z'}], settings:{focusMinutes:25}, timer:{running:true,endsAt:123} };
  assert.deepEqual(joinWorkspace(splitWorkspace(original), empty), original);
});
