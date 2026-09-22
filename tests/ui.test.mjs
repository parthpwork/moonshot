import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const html = await readFile(new URL('../public/index.html',import.meta.url),'utf8');
let saved = null;
const cloud = { async open(options) { return saved ? options.normalize(saved) : options.empty(); }, save(state) { saved=structuredClone(state);return true; }, paint() {}, onRemote:null, signOut() {}, downloadHistory() {} };
mock.module('../public/cloud.js', { namedExports:{cloud} });
const intervals = [];
const originalInterval = global.setInterval;
global.setInterval = (fn,ms) => { const id=originalInterval(fn,ms);id.unref();intervals.push(id);return id; };
let dom;
async function mount(id) {
  dom?.window.close();
  dom=new JSDOM(html,{url:'http://localhost:3000/',pretendToBeVisual:true});
  for(const key of ['window','document','Element','HTMLElement','history','location','localStorage','FormData'])global[key]=dom.window[key];
  window.scrollTo=()=>{};
  await import(`../public/app.js?render=${id}`);
  await new Promise(resolve=>setTimeout(resolve,0));
}
function input(selector,value) { const el=document.querySelector(selector);assert.ok(el,selector);el.value=value;el.dispatchEvent(new window.Event('input',{bubbles:true})); }
function click(selector) { const el=document.querySelector(selector);assert.ok(el,selector);el.click(); }
after(()=>{dom?.window.close();intervals.forEach(clearInterval);global.setInterval=originalInterval;});
test('original planning, reflection, archive, calendar and settings render with the cloud adapter',async()=>{
  await mount(1);
  assert.match(document.querySelector('h1').textContent,/Make today count/);
  input('[data-bind="intention"]','Keep showing up');
  const form=document.querySelector('form[data-form="inline-task"]');
  form.querySelector('input').value='Build the first feature';
  form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  assert.match(document.querySelector('.priority-list').textContent,/Build the first feature/);
  click('[data-action="day-tab"][data-tab="reflect"]');
  input('[data-bind="journal.thoughts"]','A real reflection saved as I type.');
  assert.ok(Object.values(saved.days).some(day=>day.journal.thoughts==='A real reflection saved as I type.'));
  click('[data-nav="journal"]');
  assert.match(document.querySelector('#journal-results').textContent,/A real reflection saved as I type/);
  click('[data-nav="calendar"]');
  assert.ok(document.querySelector('[data-action="select-day"]') || document.querySelector('.calendar-grid'));
  click('[data-action="settings"]');
  assert.match(document.querySelector('.modal').textContent,/Private cloud saving is enabled/);
  assert.ok(document.querySelector('[data-action="cloud-signout"]'));
  await mount(2);
  assert.equal(document.querySelector('[data-bind="intention"]').value,'Keep showing up');
  click('[data-action="day-tab"][data-tab="reflect"]');
  assert.equal(document.querySelector('[data-bind="journal.thoughts"]').value,'A real reflection saved as I type.');
});
