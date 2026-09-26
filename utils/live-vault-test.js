'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const babel = require('@babel/core');
const React = require('react');
const root = path.join(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const locked = error => error.code === 'WALLET_LOCKED';

const fixture = () => {
  const state = { now: 10000, storage: {}, listeners: [], events: true, failRead: false, failWrite: false, gates: [], signs: [], timers: new Map(), nextTimer: 0, passwordReads: 0, persistent: {}, failPersistent: false };
  const tails = new Map();
  const navigator = { locks: { request: (name, operation) => {
    const result = (tails.get(name) || Promise.resolve()).then(operation);
    tails.set(name, result.catch(() => {})); return result;
  } } };
  const hold = (phase, realm) => { const gate = { phase, realm, started: deferred(), release: deferred() }; state.gates.push(gate); return gate; };
  const pause = async (phase, realm) => {
    const index = state.gates.findIndex(gate => gate.phase === phase && (!gate.realm || gate.realm === realm));
    if (index < 0) return;
    const [gate] = state.gates.splice(index, 1); gate.started.resolve(); await gate.release.promise;
  };
  const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };
  const advance = async milliseconds => {
    state.now += milliseconds;
    for (let i = 0; i < 30; i++) {
      const due = [...state.timers].filter(([, timer]) => timer.at <= state.now);
      if (!due.length) break;
      for (const [id, timer] of due) { state.timers.delete(id); timer.fn(); }
      await flush();
    }
  };
  const realm = (name, extra = () => undefined) => {
    const settings = { autoLockMinutes: 15 };
    const dispatched = []; const messages = [];
    const address = text => ({ toString: () => text });
    class KeyStore {
      fromEntropy(entropy) { this.entropy = entropy; this.mnemonic = `synthetic words ${entropy}`; return this; }
      getKeyPair(index) {
        const entropy = this.entropy;
        return {
          privateKey: new Uint8Array([123]), getPrivateKey: () => new Uint8Array([123]),
          getAddress: async () => { await pause('address', name); return address(`${entropy}:${index}`); },
          getPublicKey: async () => { await pause('publicKey', name); return new Uint8Array([index, entropy.charCodeAt(0)]); },
          generateKeyPair: async function () { await pause('generate', name); return this; },
          sign: async bytes => { state.signs.push({ realm: name, entropy, index, bytes: [...bytes] }); await pause('sign', name); return new Uint8Array([index, entropy.charCodeAt(0)]); },
        };
      }
    }
    const zenon = { initialize: async () => { await pause('connect', name); if (settings.offline) throw Error('offline'); }, clearSocketConnection() {} };
    const sdk = { KeyStore, KeyFile: { encrypt: async (store, password) => {
      const baseAddress = (await store.getKeyPair(0).getAddress()).toString();
      await pause('encrypt', name);
      return { baseAddress, crypto: { syntheticCiphertext: store.entropy + ':' + password } };
    } }, KeyStoreManager: class {
      walletPath = 'znn.ts-wallet';
      listAllKeyStores() { return JSON.parse(state.persistent[this.walletPath] || '{}'); }
      async readKeyStore(password, walletName) { state.passwordReads++; await pause('password', name); if (password === 'bad') throw Error('Wrong password'); return new KeyStore().fromEntropy(walletName); }
    }, Primitives: { Address: { parse: address } }, Zenon: { getSingleton: () => zenon, getChainIdentifier: () => 69 } };
    const chrome = { storage: {
      session: {
        get: async keys => { if (state.failRead) throw Error('read failed'); const names = Array.isArray(keys) ? keys : [keys]; const values = Object.fromEntries(names.map(key => [key, state.storage[key]])); const copy = structuredClone(values); await pause('read', name); await tick(); return copy; },
        set: async values => {
          if (state.failWrite) throw Error('write failed'); await pause('write', name); const changes = {};
          for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: structuredClone(state.storage[key]), newValue: structuredClone(value) }; state.storage[key] = structuredClone(value); }
          if (state.events) queueMicrotask(() => state.listeners.forEach(listener => listener(structuredClone(changes), 'session')));
          await tick();
        },
      },
      onChanged: { addListener: listener => state.listeners.push(listener) },
    } };
    const localStorage = { getItem: key => state.persistent[key] ?? null, setItem: (key, value) => {
      if (state.failPersistent) throw Error('Persistent write failed'); state.persistent[key] = String(value);
    } };
    const fakeDate = class extends Date { static now() { return state.now; } };
    const setTimeout = (fn, ms) => { const id = ++state.nextTimer; state.timers.set(id, { fn, at: state.now + ms }); return id; };
    const clearTimeout = id => state.timers.delete(id);
    const cache = new Map();
    const storage = { getSettings: () => settings, getAddressInfo: () => ({ selectedAddressIndex: 1, maxAddressIndex: 3 }), setLastWalletName() {}, getCurrentNodeUrl: () => 'wss://example.invalid', setCurrentNodeUrl() {}, defaultNodeUrl: 'wss://example.invalid' };
    const load = file => {
      const filename = path.resolve(root, file); if (cache.has(filename)) return cache.get(filename).exports;
      const module = { exports: {} }; cache.set(filename, module);
      const { code } = babel.transformFileSync(filename, { presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react'], babelrc: false, configFile: false });
      const resolve = id => {
        const override = extra(id); if (override !== undefined) return override;
        if (id === 'znn-ts-sdk') return sdk;
        if (id.endsWith('/utils/storage')) return storage;
        if (id.endsWith('/utils/messaging')) return { sendInternalQuietly: async (method, params) => { messages.push({ method, params }); return true; } };
        if (id.endsWith('/utils/notify')) return { notify: { dismissAll() {}, error() {} } };
        if (id.endsWith('/redux/connectionParametersSlice')) return Object.fromEntries(['storeChainIdentifier', 'storeIsConnected', 'storeNodeUrl'].map(type => [type, payload => ({ type, payload })]));
        if (id.endsWith('/redux/walletSlice')) return { walletUnlocked: payload => ({ type: 'walletUnlocked', payload }), resetWalletState: () => ({ type: 'resetWalletState' }) };
        if (id.startsWith('.')) { const target = path.resolve(path.dirname(filename), id); return load(target.endsWith('.js') ? target : target + '.js'); }
        return require(id);
      };
      new Function('module', 'exports', 'require', 'chrome', 'navigator', 'Date', 'crypto', 'setTimeout', 'clearTimeout', 'localStorage', code)(module, module.exports, resolve, chrome, navigator, fakeDate, crypto, setTimeout, clearTimeout, localStorage);
      return module.exports;
    };
    return { name, settings, load, chrome, dispatched, messages, dispatch: action => dispatched.push(action), vault: load('src/services/wallet/vault.js').default, session: load('src/services/wallet/session.js').default, lease: load('src/services/wallet/sessionLease.js').default };
  };
  return { state, realm, hold, flush, advance };
};

(async () => {
  // Timed restore/touch preserves a live identity; password unlock rotates it.
  {
    const f = fixture(); const a = f.realm('a'); const b = f.realm('b');
    const scope = await a.vault.unlockWithPassword('A', 'ok', 1);
    const signer = await a.vault.getSigningKeyPair(); const publicHandle = a.vault.getKeyPair();
    assert.equal(publicHandle.sign, undefined); assert.equal(publicHandle.getPrivateKey, undefined);
    assert.equal(signer.privateKey, undefined); assert.equal(signer.getPrivateKey, undefined);
    assert.equal((await signer.getAddress()).toString(), 'A:1');
    assert.deepEqual([...await signer.sign(new Uint8Array([4]))], [1, 65]);
    const before = await b.session.load(); f.state.now += 100;
    await b.vault.restore(before, 1); await f.flush();
    assert.equal(b.vault.capture().id, scope.id); assert.equal(a.vault.isUnlocked(), true);
    assert.equal(f.state.passwordReads, 1); // restore does not decrypt again
    const extended = f.state.storage[a.session.sessionKey].expiresAt;
    assert(extended > before.expiresAt);
    await a.vault.touch({ selectedAddressIndex: 2 });
    assert.equal(f.state.storage[a.session.sessionKey].id, scope.id);
    assert.equal(f.state.storage[a.session.sessionKey].selectedAddressIndex, 2);
    await signer.sign(new Uint8Array([5]));
    await a.vault.unlockWithPassword('B', 'ok'); await f.flush();
    assert.equal(b.vault.isUnlocked(), false);
    await assert.rejects(signer.sign(new Uint8Array([6])), locked);
    assert.equal((await (await a.vault.getSigningKeyPair()).getAddress()).toString(), 'B:0');
    assert.equal(await a.vault.verifyPassword('bad'), false);
    assert.equal(await a.vault.verifyPassword('ok'), true);
  }
  // Expiry is authoritative even with all storage events and timers withheld.
  {
    const f = fixture(); const a = f.realm('a'); await a.vault.unlockWithPassword('A', 'ok');
    const signer = await a.vault.getSigningKeyPair(); const publicHandle = a.vault.getKeyPair();
    f.state.events = false; f.state.now = f.state.storage[a.session.sessionKey].expiresAt;
    assert.equal(a.vault.isUnlocked(), false);
    await assert.rejects(signer.sign(new Uint8Array([1])), locked);
    await assert.rejects(publicHandle.getPublicKey(), locked);
    await assert.rejects(a.vault.getEntropy(), locked);
    await assert.rejects(a.vault.getMnemonic(), locked);
    assert.equal(f.state.signs.length, 0);
    assert.equal(f.state.storage[a.session.sessionKey].entropy, undefined);
  }
  {
    const f = fixture(); const a = f.realm('a'); const b = f.realm('b');
    await a.vault.unlockWithPassword('A', 'ok'); await b.vault.restore(await b.session.load());
    let closed = 0; a.vault.onLock(() => closed++); b.vault.onLock(() => closed++);
    await f.advance(15 * 60000); assert.equal(closed, 2);
    assert.equal(a.vault.isUnlocked(), false); assert.equal(b.vault.isUnlocked(), false);
  }
  // Cross-context revocation remains enforced when notification delivery fails.
  {
    const f = fixture(); const a = f.realm('a'); const worker = f.realm('worker');
    await a.vault.unlockWithPassword('A', 'ok'); const key = await a.vault.getSigningKeyPair();
    f.state.events = false; await worker.lease.clear();
    await assert.rejects(key.sign(new Uint8Array([1])), locked);
    assert.equal(a.vault.isUnlocked(), false); assert.equal(f.state.signs.length, 0);
  }
  // Local lock during delayed derivation/address/crypto cannot repopulate caches
  // or release the old key/result. Re-unlock has a different generation.
  for (const phase of ['generate', 'address', 'publicKey', 'sign']) {
    const f = fixture(); const a = f.realm('a'); await a.vault.unlockWithPassword('A', 'ok');
    const signer = phase === 'sign' ? await a.vault.getSigningKeyPair() : null;
    const gate = f.hold(phase, 'a');
    const pending = phase === 'generate' ? a.vault.getSigningKeyPair() : phase === 'address' ? a.vault.getAddress() : phase === 'publicKey' ? a.vault.getKeyPair().getPublicKey() : signer.sign(new Uint8Array([1]));
    const rejected = assert.rejects(pending, locked); await gate.started.promise;
    a.vault.lock(); gate.release.resolve(); await rejected;
    await assert.rejects(a.vault.getSigningKeyPair(), locked);
    await a.vault.unlockWithPassword('B', 'ok'); assert.equal(await a.vault.getAddress(), 'B:0');
  }
  // Global lock waits only for short authorized crypto, then forbids every
  // subsequent invocation. No network or PoW runs inside this critical section.
  {
    const f = fixture(); const a = f.realm('a'); const worker = f.realm('worker');
    await a.vault.unlockWithPassword('A', 'ok'); const key = await a.vault.getSigningKeyPair();
    const gate = f.hold('sign', 'a'); const signing = key.sign(new Uint8Array([1])).catch(error => { assert(locked(error)); });
    await gate.started.promise; let completed = false;
    const clearing = worker.lease.clear().then(() => { completed = true; }); await tick(); assert.equal(completed, false);
    gate.release.resolve(); await Promise.all([signing, clearing]);
    await assert.rejects(key.sign(new Uint8Array([2])), locked);
    assert.equal(f.state.signs.length, 1);
  }
  // Expiry during crypto discards its result as well.
  {
    const f = fixture(); const a = f.realm('a'); await a.vault.unlockWithPassword('A', 'ok');
    const key = await a.vault.getSigningKeyPair(); const gate = f.hold('sign', 'a');
    const pending = assert.rejects(key.sign(new Uint8Array([1])), locked); await gate.started.promise;
    f.state.now = f.state.storage[a.session.sessionKey].expiresAt; gate.release.resolve(); await pending;
    assert.equal(a.vault.isUnlocked(), false);
  }
  // A stale touch never renews an expired/revoked/replaced lease, in either
  // ordering of a held storage read versus a concurrent global clear.
  for (const clearFirst of [false, true]) {
    const f = fixture(); const a = f.realm('a'); const b = f.realm('b'); await a.vault.unlockWithPassword('A', 'ok');
    f.state.events = false;
    const gate = f.hold('read', clearFirst ? 'b' : 'a');
    const first = clearFirst ? b.lease.clear() : a.vault.touch();
    await gate.started.promise;
    const second = clearFirst ? a.vault.touch().catch(error => { assert(locked(error)); }) : b.lease.clear();
    gate.release.resolve(); await Promise.all([first, second]);
    assert.equal(f.state.storage[a.session.sessionKey].entropy, undefined);
    await assert.rejects(a.vault.touch(), locked);
  }
  {
    const f = fixture(); const a = f.realm('a'); await a.vault.unlockWithPassword('A', 'ok');
    f.state.now = f.state.storage[a.session.sessionKey].expiresAt;
    await assert.rejects(a.vault.touch(), locked); assert.equal(await a.session.load(), null);
  }
  // An expired load cannot delete a replacement unlock that queued behind it.
  {
    const f = fixture(); const a = f.realm('a'); const b = f.realm('b');
    await a.vault.unlockWithPassword('A', 'ok'); f.state.events = false;
    f.state.now = f.state.storage[a.session.sessionKey].expiresAt;
    const gate = f.hold('read', 'a'); const loading = a.session.load(); await gate.started.promise;
    const replacement = b.vault.unlockWithPassword('B', 'ok'); gate.release.resolve();
    assert.equal(await loading, null); await replacement;
    assert.equal((await b.session.load()).walletName, 'B');
  }
  // Pending password verification/unlock and a captured restore cannot revive
  // a generation cleared by another context, even when the store was empty.
  {
    const f = fixture(); const a = f.realm('a'); const b = f.realm('b');
    const gate = f.hold('password', 'a'); const pending = assert.rejects(a.vault.unlockWithPassword('A', 'ok'), locked);
    await gate.started.promise; await b.lease.clear(); gate.release.resolve(); await pending;
    assert.equal(a.vault.isUnlocked(), false);
    await a.vault.unlockWithPassword('A', 'ok'); const record = await b.session.load();
    await a.session.clear(); await assert.rejects(b.vault.restore(record), locked);
    await a.vault.unlockWithPassword('A', 'ok'); const verifyGate = f.hold('password', 'a');
    const verifying = a.vault.verifyPassword('ok'); await verifyGate.started.promise;
    await b.lease.clear(); verifyGate.release.resolve(); assert.equal(await verifying, false);
  }
  // On close keeps no shared entropy, cannot restore in a fresh document,
  // remains usable in its owner, and still obeys global lock/replacement.
  {
    const f = fixture(); const a = f.realm('a'); const b = f.realm('b'); a.settings.autoLockMinutes = 0;
    const scope = await a.vault.unlockWithPassword('A', 'ok'); const key = await a.vault.getSigningKeyPair();
    const marker = f.state.storage[a.session.sessionKey]; assert.equal(marker.mode, 'local'); assert.equal(marker.entropy, undefined);
    assert.equal(await b.session.load(), null); await assert.rejects(b.vault.restore(marker), locked);
    await a.session.publish(scope.id, { address: 'A:0' }); assert.equal(await b.lease.getPublicState(), null);
    await b.lease.expire(); await key.sign(new Uint8Array([1]));
    await a.vault.touch(); await key.sign(new Uint8Array([2]));
    await b.vault.unlockWithPassword('B', 'ok'); await f.flush();
    await assert.rejects(key.sign(new Uint8Array([3])), locked);
  }
  // A selected index change during key generation cannot mismatch the returned
  // signature/public key/address; all three use one captured handle.
  {
    const f = fixture(); const a = f.realm('a'); await a.vault.unlockWithPassword('A', 'ok');
    const gate = f.hold('generate', 'a'); const { signMessage } = a.load('src/services/wallet/signMessage.js');
    const pending = signMessage('synthetic'); await gate.started.promise; a.vault.setSelectedIndex(1); gate.release.resolve();
    const result = await pending; assert.equal(result.address, 'A:0'); assert.equal(result.publicKey, '0041'); assert.equal(result.signature, '0041');
  }
  // Conditional publication and restore cleanup cannot affect a newer lease.
  {
    const f = fixture(); const a = f.realm('a'); const b = f.realm('b');
    const old = await a.vault.unlockWithPassword('A', 'ok');
    const current = await b.vault.unlockWithPassword('B', 'ok');
    await assert.rejects(a.session.publish(old.id, { address: 'A:0' }), locked);
    assert.equal(await a.session.clear(old.id), null);
    await b.session.publish(current.id, { address: 'B:0' });
    assert.equal((await a.lease.getPublicState()).address, 'B:0');
    assert.equal(await a.lease.getPublicState(old.id), null);
  }
  // Failed shared storage reads and writes never yield an unlocked signer.
  for (const mode of ['read', 'write']) {
    const f = fixture(); const a = f.realm('a');
    f.state[mode === 'read' ? 'failRead' : 'failWrite'] = true;
    await assert.rejects(a.vault.unlockWithPassword('A', 'ok'), locked);
    assert.equal(a.vault.isUnlocked(), false);
  }
  {
    const f = fixture(); const a = f.realm('a'); await a.vault.unlockWithPassword('A', 'ok'); const key = await a.vault.getSigningKeyPair();
    f.state.failRead = true; await assert.rejects(key.sign(new Uint8Array([1])), locked); assert.equal(f.state.signs.length, 0);
  }
  // Password encryption is deliberately outside the lock; only an authorized
  // synchronous commit can replace the encrypted wallet. No late write or toast.
  for (const mode of ['control', 'remote-lock', 'local-lock', 'expiry', 'replacement']) {
    const f = fixture(); const a = f.realm('password'); const b = f.realm('other');
    f.state.persistent['znn.ts-wallet'] = JSON.stringify({ other: { untouched: true }, 'A-wallet': { old: true } });
    await a.vault.unlockWithPassword('A wallet', 'ok');
    const gate = f.hold('encrypt', 'password');
    const change = a.vault.changePassword('ok', 'new password');
    const result = mode === 'control' ? change : assert.rejects(change, locked);
    await gate.started.promise;
    // Notifications can be lost; the shared check at commit must still deny.
    f.state.events = false;
    if (mode === 'remote-lock') await b.lease.clear();
    if (mode === 'local-lock') a.vault.lock();
    if (mode === 'expiry') f.state.now = f.state.storage[a.session.sessionKey].expiresAt;
    if (mode === 'replacement') await b.vault.unlockWithPassword('B', 'ok');
    gate.release.resolve(); await result;
    const saved = JSON.parse(f.state.persistent['znn.ts-wallet']);
    assert.deepEqual(saved.other, { untouched: true });
    if (mode === 'control') {
      assert.equal(saved['A-wallet'].baseAddress, 'A wallet:0');
      assert.equal(saved['A-wallet'].crypto.syntheticCiphertext, 'A wallet:new password');
      assert.equal(await a.vault.changePassword('bad', 'never'), false);
      f.state.failPersistent = true;
      await assert.rejects(a.vault.changePassword('ok', 'failed'), /Persistent write failed/);
    } else assert.deepEqual(saved['A-wallet'], { old: true });
  }
  {
    const f = fixture(); let toasts = 0;
    const a = f.realm('notify', id => id === 'react-toastify' ? { toast: () => toasts++ } : undefined);
    const { notify } = a.load('src/services/utils/notify.js');
    assert.equal(notify.error(a.session.ended()), null);
    assert.equal(notify.error(Error('The wallet is locked')), null);
    assert.equal(toasts, 0);
    notify.error(Error('Ordinary failure')); assert.equal(toasts, 1);
  }
  // The real bootstrap preserves offline unlock and blocks late node completion
  // from advertising a revoked lease.
  {
    const f = fixture(); const a = f.realm('a'); a.settings.offline = true;
    const { completeUnlock } = a.load('src/services/wallet/bootstrap.js');
    const result = await completeUnlock({ walletName: 'A', password: 'ok', dispatch: a.dispatch });
    assert.equal(result.address, 'A:1'); assert.equal(result.isConnected, false);
    assert.equal((await a.lease.getPublicState()).address, 'A:1');
    const b = f.realm('b'); const bootstrap = b.load('src/services/wallet/bootstrap.js'); const gate = f.hold('connect', 'b');
    const pending = assert.rejects(bootstrap.completeUnlock({ walletName: 'B', password: 'ok', dispatch: b.dispatch }), locked);
    await gate.started.promise; b.vault.lock(); await b.session.clear(); gate.release.resolve(); await pending;
    assert.equal(await b.lease.getPublicState(), null); assert.equal(b.messages.length, 0);
    assert(!b.dispatched.some(action => action.type === 'storeIsConnected' && action.payload === true));
  }

  // Execute the real MainLayout lock subscription: leave a secret-bearing
  // route, clear wallet/pending/cache state, retain the approval return route,
  // and never clear a newer lease from another document.
  for (const route of ['/tabs/settings/export-mnemonic', '/site-integration']) {
    const f = fixture(); const effects = []; const navigation = []; const actions = []; let invalidated = 0;
    const mockReact = { ...React, useEffect: (fn, deps) => effects.push({ fn, deps }), useRef: value => ({ current: value }), useState: value => [value, () => {}] };
    const a = f.realm('ui', id => {
      if (id === 'react') return mockReact;
      if (id === 'react-redux') return { useDispatch: () => action => actions.push(action) };
      if (id === 'react-router-dom') return { useLocation: () => ({ pathname: route }), useNavigate: () => (to, options) => navigation.push({ to, options }), Route: 'route', Routes: 'routes' };
      if (/Layout\/(authLayout|tabsLayout|siteIntegrationLayout)$|dashboard-password|initial-node-selection|splash\/splash/.test(id)) return () => null;
      if (id.endsWith('/wallet/bootstrap')) return { completeUnlock() {} };
      if (id.endsWith('/utils/utils')) return { loadStorageWalletNames: () => ['A'] };
      if (id.endsWith('/utils/devWallet')) return { isDevWalletBuild: false };
      if (id.endsWith('/hooks/useAccount')) return { invalidateAccountCache: () => invalidated++ };
      if (id.endsWith('/redux/pendingTransactionsSlice')) return { resetPendingTransactions: () => ({ type: 'resetPendingTransactions' }) };
    });
    const MainLayout = a.load('src/layouts/mainLayout/mainLayout.js').default;
    MainLayout(); const unsubscribe = effects.find(effect => effect.deps?.length === 2).fn();
    await a.vault.unlockWithPassword('A', 'ok');
    const b = f.realm('other'); const newer = await b.vault.unlockWithPassword('B', 'ok'); await f.flush();
    assert.equal(invalidated, 1);
    assert.deepEqual(actions.map(action => action.type), ['resetPendingTransactions', 'resetWalletState']);
    assert.equal(navigation[0].to, '/password');
    assert.equal(navigation[0].options.state.returnTo, route === '/site-integration' ? route : null);
    assert.equal(f.state.storage[a.session.sessionKey].id, newer.id);
    unsubscribe();
  }
  // Installed SDK controls: real derivation, public address/key, Ed25519
  // signing/verification, and its complete block pipeline with an inert ledger.
  // Delayed RPC/PoW responses occur outside the lease critical section, so a
  // completed remote lock prevents the real SDK from reaching raw signing.
  {
    global.window = { crypto: require('node:crypto').webcrypto };
    global.self = global.window; // The SDK browser bundle selects WebCrypto through self.
    const values = new Map();
    global.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
    const sdk = require('znn-ts-sdk'); const { BigNumber } = require('ethers'); const cryptoModule = require('node:crypto');
    sdk.Zenon.setChainIdentifier(69);
    const silent = async operation => { const log = console.log; console.log = () => {}; try { return await operation(); } finally { console.log = log; } };
    for (const phase of ['control', 'rpc', 'pow']) {
      const f = fixture(); let rawSignatures = 0; let published = 0;
      const sdkFacade = { ...sdk, KeyStoreManager: class { async readKeyStore() {
        const store = new sdk.KeyStore().fromEntropy('00'.repeat(32)); const derive = store.getKeyPair.bind(store);
        store.getKeyPair = index => { const key = derive(index); const sign = key.sign.bind(key); key.sign = bytes => { rawSignatures++; return sign(bytes); }; return key; };
        return store;
      } } };
      const a = f.realm('sdk', id => id === 'znn-ts-sdk' ? sdkFacade : undefined);
      const worker = f.realm('worker'); await a.vault.unlockWithPassword('synthetic', 'synthetic', 1);
      const key = await a.vault.getSigningKeyPair(); const address = await key.getAddress();
      const publicKey = await key.getPublicKey(); assert.equal(publicKey.length, 32);
      if (phase === 'control') {
        const message = new Uint8Array([1, 2, 3]); const signature = await key.sign(message); assert.equal(signature.length, 64);
        const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey)]);
        assert(cryptoModule.verify(null, message, cryptoModule.createPublicKey({ key: spki, format: 'der', type: 'spki' }), signature));
      }
      const gate = { started: deferred(), release: deferred() };
      const wait = async selected => { if (phase === selected) { gate.started.resolve(); await gate.release.promise; } };
      const zenon = {
        ledger: {
          getFrontierBlock: async () => { await wait('rpc'); return null; },
          getFrontierMomentum: async () => ({ height: 100, hash: sdk.Primitives.Hash.parse('1'.repeat(64)) }),
          publishRawTransaction: async block => {
            const json = block.toJson();
            assert.equal(json.publicKey, Buffer.from(publicKey).toString('base64'));
            assert.equal(Buffer.from(json.publicKey, 'base64').length, 32);
            assert.equal(Buffer.from(json.signature, 'base64').length, 64);
            published++;
          },
        },
        embedded: { plasma: { getRequiredPoWForAccountBlock: async () => { await wait('pow'); return { requiredDifficulty: 0, basePlasma: 21000 }; } } },
      };
      const template = sdk.Primitives.AccountBlockTemplate.send(address, sdk.Primitives.TokenStandard.parse('zts1znnxxxxxxxxxxxxx9z4ulx'), BigNumber.from(1));
      const before = rawSignatures;
      if (phase === 'control') {
        const signed = await silent(() => sdk.utils.BlockUtils.send(zenon, template, key));
        assert.equal(signed.address.toString(), address.toString()); assert.equal(published, 1); assert.equal(rawSignatures, before + 1);
      } else {
        const pending = assert.rejects(silent(() => sdk.utils.BlockUtils.send(zenon, template, key)), locked);
        await gate.started.promise; await worker.lease.clear(); gate.release.resolve(); await pending;
        assert.equal(rawSignatures, before); assert.equal(published, 0);
      }
    }
  }

  console.log('live vault: lease identity, expiry, cross-context revocation, stale async/cache completion, On close, selected signer binding, publication, storage failures and bootstrap controls passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
