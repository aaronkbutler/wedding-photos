// Protocol-level browser harness: exercise the actual guest script with a lost
// upload response. Visual/browser coverage remains a separate launch check.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

class Node {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.dataset = {}; this.value = ''; this.textContent = ''; this.hidden = false; this.classList = {add(){},remove(){},toggle(){}}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  setAttribute() {}
  querySelector() { return null; }
  fire(name, event = {}) { for (const fn of this.listeners[name] || []) fn(event); }
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('The guest script did not finish the expected operation');
}
function createPage(fetch) {
  const nodes = new Map();
  const filters = ['all','photo','video'].map(filter => { const node = new Node('button'); node.dataset.filter = filter; return node; });
  const document = {getElementById(id) { if (!nodes.has(id)) nodes.set(id,new Node()); return nodes.get(id); },createElement:tag => new Node(tag),querySelectorAll:() => filters,body:new Node('body')};
  const window = {WEDDING_PHOTOS_API:'https://album.example',addEventListener(){}};
  const location = {origin:'https://guest.example',href:'https://guest.example/#event=test-invite',hash:'#event=test-invite',search:''};
  const context = vm.createContext({document,window,location,sessionStorage:{getItem(){return null;},setItem(){}},crypto:webcrypto,URL,URLSearchParams,Headers,AbortController,fetch,console,setTimeout:fn => setImmediate(fn)});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),context);
  return {node:id => document.getElementById(id)};
}
const json = (data,status = 200) => new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});

test('a lost chunk response reconciles the saved offset and never reports incomplete data as shared', async () => {
  const chunk = 2 * 1024 * 1024;
  const size = 2 * chunk + 117;
  const ranges = [];
  let offset = 0, statusChecks = 0, galleryReads = 0, sessions = 0;
  const page = createPage(async (url,options = {}) => {
    const endpoint = new URL(url).pathname;
    if (endpoint === '/api/config') return json({configured:true,uploadsOpen:true,chunkBytes:chunk,maxFileBytes:1073741824});
    if (endpoint === '/api/guest/session') { sessions++; return json({token:'guest-token',expiresAt:Date.now()+3600000}); }
    assert.equal(options.headers.get('Authorization'),'Bearer guest-token');
    if (endpoint === '/api/gallery') { galleryReads++; return json({items:[],nextCursor:null}); }
    if (endpoint === '/api/uploads') {
      const input = JSON.parse(options.body);
      assert.equal(input.guestName,'A guest');
      assert.equal(input.caption,'On the dance floor');
      assert.match(input.uploadKey,/^[a-f\d-]{36}$/);
      return json({id:'upload-id',uploadToken:'upload-proof',offset:0,chunkBytes:chunk});
    }
    assert.equal(options.headers.get('X-Upload-Token'),'upload-proof');
    if (options.method === 'PUT') {
      const range = options.headers.get('Content-Range');
      ranges.push(range);
      const [,start,end,total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(range).map(Number);
      assert.equal(start,offset);
      assert.equal(total,size);
      assert.equal(options.body.size,end-start+1);
      offset = end+1;
      if (ranges.length === 1) throw new TypeError('The network disappeared after Drive saved the chunk');
      return json({id:'upload-id',offset,complete:offset===size});
    }
    statusChecks++;
    return json({id:'upload-id',offset,complete:offset===size});
  });
  await until(() => galleryReads === 1);
  page.node('guest-name').value = 'A guest';
  page.node('caption').value = 'On the dance floor';
  page.node('file-input').fire('change',{target:{files:[{name:'dance.mov',type:'video/quicktime',size,lastModified:1,slice:(start,end) => new Blob([new Uint8Array(end-start)])}]}});
  page.node('start-upload').fire('click');
  await until(() => galleryReads === 2);
  assert.equal(offset,size);
  assert.equal(statusChecks,1);
  assert.equal(sessions,1);
  assert.deepEqual(ranges,[`bytes 0-${chunk-1}/${size}`,`bytes ${chunk}-${2*chunk-1}/${size}`,`bytes ${2*chunk}-${size-1}/${size}`]);
  assert.match(page.node('upload-message').textContent,/1 moment shared/);
});

test('a server response with complete=true but a short offset cannot be shown as success', async () => {
  let galleryReads = 0, writes = 0;
  const page = createPage(async (url, options = {}) => {
    const endpoint = new URL(url).pathname;
    if (endpoint === '/api/config') return json({configured:true,uploadsOpen:true});
    if (endpoint === '/api/guest/session') return json({token:'guest-token',expiresAt:Date.now()+3600000});
    if (endpoint === '/api/gallery') { galleryReads++; return json({items:[],nextCursor:null}); }
    if (endpoint === '/api/uploads') return json({id:'upload-id',uploadToken:'proof',offset:0,chunkBytes:8388608});
    writes++;
    return json({id:'upload-id',offset:42,complete:true});
  });
  await until(() => galleryReads === 1);
  page.node('file-input').fire('change',{target:{files:[{name:'moment.mov',type:'video/quicktime',size:500,lastModified:1,slice:(start,end) => new Blob([new Uint8Array(end-start)])}]}});
  page.node('start-upload').fire('click');
  await until(() => page.node('upload-message').textContent.includes('Resume or retry'));
  assert.equal(galleryReads,1);
  assert.equal(writes,1);
  assert.doesNotMatch(page.node('upload-message').textContent,/moment shared/);
});
