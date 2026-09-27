'use strict';
// Optional native coordination check. Actual queue/identity modules, synthetic
// metadata, a fresh MV3 profile and inert test pages only. No wallet or node.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.join(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syrius-approval-queue-'));
const ext = path.join(dir, 'extension'); fs.mkdirSync(ext);
fs.writeFileSync(path.join(ext, 'requests.js'), fs.readFileSync(path.join(root, 'src/sections/Background/requests.js'), 'utf8').replace("'../../services/utils/approvalIdentity'", "'./approvalIdentity.js'").replace("'../../services/utils/approvalLimits'", "'./approvalLimits.js'"));
fs.copyFileSync(path.join(root, 'src/services/utils/approvalIdentity.js'), path.join(ext, 'approvalIdentity.js'));
fs.copyFileSync(path.join(root, 'src/services/utils/approvalLimits.js'), path.join(ext, 'approvalLimits.js'));
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Isolated approval queue checks', version: '1.0', minimum_chrome_version: '112', permissions: ['storage'], background: { service_worker: 'worker.js', type: 'module' } }));
fs.writeFileSync(path.join(ext, 'worker.js'), `import requests from './requests.js'; let expired=0; requests.onExpired(rows=>{expired+=rows.length}); chrome.runtime.onMessage.addListener((message,sender,reply)=>{if(message.kind!=='fixture')return false;if(message.method==='advance'){const now=Date.now();Date.now=()=>now+message.args[0];reply({result:true});return false;}if(message.method==='expired'){reply({result:expired});return false;}Promise.resolve(requests[message.method](...message.args)).then(result=>reply({result}),error=>reply({error:String(error)}));return true;});`);
fs.writeFileSync(path.join(ext, 'page.html'), '<!doctype html><title>Isolated approval checks</title><script type="module" src="page.js"></script>');
fs.writeFileSync(path.join(ext, 'page.js'), `import requests from './requests.js';import {identityOf} from './approvalIdentity.js';Object.assign(window,{requests,identityOf,worker:(method,...args)=>new Promise((resolve,reject)=>chrome.runtime.sendMessage({kind:'fixture',method,args},response=>chrome.runtime.lastError?reject(Error(chrome.runtime.lastError.message)):response.error?reject(Error(response.error)):resolve(response.result)))});`);
const browser = spawn(process.env.CHROMIUM_PATH || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + path.join(dir, 'profile'), '--enable-unsafe-extension-debugging', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '', launchError, socket, cdp;
browser.stderr.on('data', value => { stderr += value; }); browser.on('error', error => { launchError = error; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { console.error('Native approval queue checks timed out'); socket?.close(); browser.kill(); process.exit(1); }, 60000);
(async () => {
  let port;
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    const file = path.join(dir, 'profile', 'DevToolsActivePort');
    if (fs.existsSync(file)) { port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); break; }
    await pause(100);
  }
  assert(port, 'Browser started: ' + stderr.slice(-400));
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  socket = new WebSocket(version.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0; const pending = new Map();
  socket.onmessage = event => { const message = JSON.parse(event.data), call = pending.get(message.id); if (call) { pending.delete(message.id); message.error ? call.reject(Error(JSON.stringify(message.error))) : call.resolve(message.result); } };
  cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const extension = await cdp('Extensions.loadUnpacked', { path: ext });
  const evaluate = async (page, expression) => { const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page.sessionId); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  const createPage = async () => {
    const target = await cdp('Target.createTarget', { url: `chrome-extension://${extension.id}/page.html` });
    const page = { ...target, ...await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true }) };
    for (let i = 0; i < 60; i++) { if (await evaluate(page, "typeof requests === 'object'")) return page; await pause(50); }
    throw Error('Actual queue module did not initialize');
  };
  const pages = [await createPage(), await createPage()];
  const windowId = await evaluate(pages[0], 'chrome.windows.getCurrent().then(value=>value.id)');
  const base = { responseId: 'native', documentId: 'doc-a', type: 'signAndSendBlock', params: { data: { type: 'Buffer', data: Array(16384).fill(255) }, amount: '0' }, tabId: 1, frameId: 0, origin: 'https://fixture.invalid', title: '', favicon: '' };
  const results = await Promise.all(Array.from({ length: 17 }, (_, i) => evaluate(pages[i % 2], `${i % 3 === 0 ? "worker('add'," : 'requests.add('}${JSON.stringify({ ...base, responseId: i, origin: 'https://slot-' + i + '.invalid' })}).then(value=>({ok:true,id:value.id}),error=>({ok:false,error:String(error)}))`)));
  assert.equal(results.filter(x=>x.ok).length,16); assert.equal(results.filter(x=>!x.ok).length,1);
  const rows = await evaluate(pages[0], 'requests.list()'); assert.equal(rows.length,16);
  assert(rows.every(row=>row.params.data.data.length===16384 && row.params.data.data.every(x=>x===255)));
  const bytesInUse = await evaluate(pages[0], 'chrome.storage.session.getBytesInUse()');
  const a = rows[0], identity = await evaluate(pages[0], `identityOf(${JSON.stringify(a)})`);
  await evaluate(pages[0], `requests.attachWindow(${JSON.stringify(identity)},${windowId})`);
  const claims = await Promise.all([
    evaluate(pages[0], `requests.claim(${JSON.stringify(identity)},${windowId})`),
    evaluate(pages[1], `requests.claim(${JSON.stringify(identity)},${windowId})`),
    evaluate(pages[0], `worker('claim',${JSON.stringify(identity)},${windowId})`),
  ]);
  assert.equal(claims.filter(Boolean).length,1); const winner=claims.find(Boolean);
  const fresh = await createPage();
  assert.equal(await evaluate(fresh, `requests.checkClaim(${JSON.stringify(winner)})`),true);
  await evaluate(pages[0], "worker('advance',30*60*1000)");
  await evaluate(pages[0], "worker('prune')");
  assert.equal(await evaluate(pages[0], "worker('expired')"),16);
  assert.equal((await evaluate(fresh,'requests.list()')).length,0);
  assert.equal(await evaluate(fresh,`requests.checkClaim(${JSON.stringify(winner)})`),false);
  const result = { browser:version.Browser, concurrentNativeAdmissions:16, nextAdmissionRejected:true, fullCalldataEntriesRetained:16, bytesInUse, sessionQuota:10485760, oneClaimAcrossPagesAndWorker:true, freshRealmReadsPersistedClaim:true, workerExpiryRemoved:16, expiredClaimDeniedInFreshRealm:true, profile:dir };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  await cdp('Browser.close'); socket.close();
})().catch(async error => { console.error(error.stack || String(error)); if (cdp) await cdp('Browser.close').catch(() => {}); socket?.close(); browser.kill(); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
