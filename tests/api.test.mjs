import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const pg = new PGlite();
function sql(strings, ...values) {
  const query = strings.reduce((s, part, i) => s + (i ? `$${i}` : '') + part, '');
  return pg.query(query, values).then(result => result.rows);
}
sql.transaction = promises => Promise.all(promises);
mock.module('@neondatabase/serverless', { namedExports:{ neon:() => sql } });
process.env.DATABASE_URL = 'postgres://isolated-test-only';
process.env.MOONSHOT_SETUP_TOKEN = 'test-only-setup-code-that-is-at-least-32-characters';
const { default: session } = await import('../api/session.js');
const { default: workspace } = await import('../api/workspace.js');
const { default: history } = await import('../api/history.js');
const { verifyPassword } = await import('../lib/security.js');
after(() => pg.close());
async function call(handler, method, input, cookie, origin = 'http://localhost:3000', query = {}) {
  const req = { method, body:input, query, headers:{ host:'localhost:3000', origin, 'content-type':'application/json', cookie }, socket:{remoteAddress:'127.0.0.1'} };
  const result = { status:200, headers:{}, body:null };
  const res = { status(n) { result.status=n; return this; }, setHeader(k,v) { result.headers[k.toLowerCase()]=v; }, json(v) { result.body=v; return this; }, end() { return this; } };
  await handler(req, res); return result;
}
let cookie;
test('private API lifecycle, persistence, snapshots, conflict checks, CSRF, and logout', async t => {
  await t.test('unauthenticated visitors cannot read or write workspace or history', async () => {
    assert.equal((await call(workspace,'GET')).status,401);
    assert.equal((await call(workspace,'PUT',{})).status,401);
    assert.equal((await call(history,'GET')).status,401);
  });
  await t.test('only the setup secret can initialize the private owner', async () => {
    assert.equal((await call(session,'POST',{action:'setup',password:'a-long-test-password',setupToken:'wrong'})).status,403);
    const result=await call(session,'POST',{action:'setup',password:'a-long-test-password',setupToken:process.env.MOONSHOT_SETUP_TOKEN});
    assert.equal(result.status,200);
    cookie=result.headers['set-cookie'].split(';')[0];
    assert.match(result.headers['set-cookie'],/HttpOnly/);
    const rows=await pg.query('SELECT password_hash FROM moonshot_owner');
    assert.notEqual(rows.rows[0].password_hash,'a-long-test-password');
    assert.equal(await verifyPassword('a-long-test-password',rows.rows[0].password_hash),true);
    assert.equal((await call(session,'POST',{action:'setup',password:'replacement-password',setupToken:process.env.MOONSHOT_SETUP_TOKEN})).status,409);
  });
  const packet={key:'day:2026-09-22',data:{journal:{thoughts:'First reflection'}},revision:0,operationId:'operation-test-first-123456'};
  await t.test('cross-site writes are rejected',async()=>{
    assert.equal((await call(workspace,'PUT',packet,cookie,'https://evil.example')).status,403);
  });
  await t.test('save, reload, duplicate retry, and compare-and-swap use real Postgres',async()=>{
    const first=await call(workspace,'PUT',packet,cookie);assert.equal(first.status,200);assert.equal(first.body.record.revision,1);
    const retry=await call(workspace,'PUT',packet,cookie);assert.equal(retry.status,200);assert.equal(retry.body.record.revision,1);
    const read=await call(workspace,'GET',null,cookie);assert.equal(read.body.records[0].data.journal.thoughts,'First reflection');
    const second={...packet,revision:1,operationId:'operation-test-second-123456',data:{journal:{thoughts:'Second reflection'}}};
    const update=await call(workspace,'PUT',second,cookie);assert.equal(update.status,200);assert.equal(update.body.record.revision,2);
    const conflict=await call(workspace,'PUT',{...second,operationId:'operation-test-conflict-123456'},cookie);assert.equal(conflict.status,409);assert.equal(conflict.body.record.data.journal.thoughts,'Second reflection');
    const saved=await pg.query('SELECT data FROM moonshot_history');assert.equal(saved.rows[0].data.journal.thoughts,'First reflection');
  });
  await t.test('recovery API returns history only to the signed-in owner',async()=>{
    const list=await call(history,'GET',null,cookie,undefined,{key:packet.key});assert.equal(list.body.records.length,1);
    const item=await call(history,'GET',null,cookie,undefined,{key:packet.key,hour:list.body.records[0].hour});assert.equal(item.body.records[0].data.journal.thoughts,'First reflection');
  });
  await t.test('malformed record IDs and oversized entries fail safely',async()=>{
    assert.equal((await call(workspace,'PUT',{...packet,key:'../admin'},cookie)).status,400);
    assert.equal((await call(workspace,'PUT',{...packet,data:{text:'x'.repeat(1024*1024+1)}},cookie)).status,413);
  });
  await t.test('sign-out revokes the server session',async()=>{
    assert.equal((await call(session,'POST',{action:'logout'},cookie)).status,200);
    assert.equal((await call(workspace,'GET',null,cookie)).status,401);
  });
  await t.test('wrong-password attempts are rate-limited in the database',async()=>{
    let response;
    for(let i=0;i<12;i++)response=await call(session,'POST',{action:'login',password:'wrong-but-long-password'});
    assert.equal(response.status,429);
  });
});
