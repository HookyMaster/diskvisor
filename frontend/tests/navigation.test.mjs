import test from "node:test";
import assert from "node:assert/strict";
import { createTreeStore } from "../src/tree-store.mjs";
import { createFrameBatcher, createSelectionJobs } from "../src/interaction-jobs.mjs";

const key = p => (p || "").toLowerCase().replaceAll("/", "\\").replace(/[\\]+$/, "");
const defer = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test("tree and treemap share one directory request and canonical child references", async () => {
  const pending = defer(); let calls=0;
  const store = createTreeStore(() => { calls++; return pending.promise; },key);
  const root = store.reset({path:"C:\\demo",is_dir:true});
  const a=store.load(root), b=store.load(root);
  await Promise.resolve();
  assert.equal(calls,1);
  pending.resolve([{path:"C:\\demo\\folder",name:"folder",is_dir:true,children:[{path:"C:\\demo\\folder\\file",name:"file"}]}]);
  const [left,right]=await Promise.all([a,b]);
  assert.equal(left,right);
  assert.equal(root.children[0],store.get("c:/demo/folder"));
  assert.equal(root.children[0].children[0],store.get("C:\\demo\\folder\\file"));
  await store.load(root);
  assert.equal(calls,1);
});

test("empty directories are loaded once even when file_count is zero",async()=>{
  let calls=0;
  const store=createTreeStore(async()=>{calls++;return [];},key);
  const root=store.reset({path:"C:\\empty",is_dir:true,file_count:0});
  await store.load(root); await store.load(root);
  assert.equal(calls,1); assert.deepEqual(root.children,[]);
});

test("a previous scan cannot populate the next scan's node index",async()=>{
  const pending=defer();
  const store=createTreeStore(()=>pending.promise,key);
  const first=store.reset({path:"C:\\old",is_dir:true});
  const loading=store.load(first);
  const current=store.reset({path:"C:\\new",is_dir:true});
  pending.resolve([{path:"C:\\old\\stale"}]);
  await assert.rejects(loading,/superseded/);
  assert.equal(store.get("C:\\old\\stale"),undefined);
  assert.equal(store.get("C:\\new"),current);
});

test("failed directory loads can be retried",async()=>{
  let calls=0;
  const store=createTreeStore(async()=>{if(++calls===1)throw Error("disk busy");return [];},key);
  const root=store.reset({path:"C:\\retry",is_dir:true});
  await assert.rejects(store.load(root),/disk busy/);
  await store.load(root); assert.equal(calls,2);
});

test("rapid render requests share one frame and settle every caller",async()=>{
  const callbacks=[]; let draws=0;
  const render=createFrameBatcher(callback=>callbacks.push(callback),()=>{draws++;});
  const promises=Array.from({length:50},()=>render());
  assert.equal(callbacks.length,1);
  callbacks.shift()(); await Promise.all(promises);
  assert.equal(draws,1);
  const next=render(); callbacks.shift()(); await next; assert.equal(draws,2);
});

test("navigation completes while AI is pending; outdated AI results are ignored",async()=>{
  const pending=defer(); const linked=[],shown=[];
  const jobs=createSelectionJobs({delay:0,link:async n=>linked.push(n.path),analyze:p=>p==="a"?pending.promise:Promise.resolve("b-result"),show:(n,r)=>shown.push([n.path,r]),failure:()=>{}});
  await jobs.select({path:"a"},{});
  assert.deepEqual(linked,["a"]); assert.deepEqual(shown,[]);
  await tick(); // starts the first request, which stays unresolved
  await jobs.select({path:"b"},{}); await tick();
  pending.resolve("a-result"); await tick();
  assert.deepEqual(shown,[["b","b-result"]]);
  jobs.reset();
});

test("rapid selections debounce AI calls and reset invalidates pending work",async()=>{
  const called=[];
  const jobs=createSelectionJobs({delay:0,link:async()=>{},analyze:async p=>{called.push(p);return p;},show:()=>{},failure:()=>{}});
  await jobs.select({path:"a"},{}); await jobs.select({path:"b"},{}); await jobs.select({path:"c"},{});
  await tick(); assert.deepEqual(called,["c"]);
  await jobs.select({path:"d"},{}); jobs.reset(); await tick(); assert.deepEqual(called,["c"]);
});
