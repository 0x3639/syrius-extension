'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const babel = require('@babel/core');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
global.window = { crypto: require('node:crypto').webcrypto, close() {} };
const memory = new Map();
global.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)) };
const sdk = require('znn-ts-sdk');
const { BigNumber } = require('ethers');
const root = path.join(__dirname, '..');
const loadModules = (override) => {
  const cache = new Map();
  const load = (file) => {
    const filename = path.resolve(root, file);
    if (cache.has(filename)) return cache.get(filename);
    const mod = { exports: {} };
    const { code } = babel.transformFileSync(filename, { presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react'], babelrc: false, configFile: false });
    const resolve = name => {
      const value = override(name);
      if (value !== undefined) return value;
      if (name.startsWith('.')) {
        const target = path.resolve(path.dirname(filename), name);
        return load(target.endsWith('.js') ? target : `${target}.js`);
      }
      return require(name);
    };
    new Function('module', 'exports', 'require', code)(mod, mod.exports, resolve);
    cache.set(filename, mod.exports);
    return mod.exports;
  };
  return load;
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const address = sdk.Primitives.Address.parse('z1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsggv2f');
const hash = sdk.Primitives.Hash.parse('1'.repeat(64));
const zts = 'zts1znnxxxxxxxxxxxxx9z4ulx';
const keyBytes = Buffer.alloc(32, 7);
const blockJson = (amount = '100000000') => sdk.Primitives.AccountBlockTemplate.send(address, sdk.Primitives.TokenStandard.parse(zts), BigNumber.from(amount)).toJson();

const fixture = () => {
  sdk.Zenon.setChainIdentifier(69);
  const state = { current: true, unlocked: true, index: 0, wallet: 'fixture', chain: 69, node: 'wss://example.invalid', height: 4, signs: 0, fills: 0, publishes: [], pause: null, gate: null, badKey: false };
  const pause = async phase => {
    if (state.pause === phase) {
      const gate = state.gate;
      gate.started.resolve();
      await gate.release.promise;
    }
  };
  const key = { getAddress: async () => address, getPublicKey: async () => keyBytes };
  state.key = key;
  const signer = {
    getAddress: async () => { await pause('signer'); return state.badAddress ? sdk.Primitives.Address.parse('z1qxemdeddedxplasmaxxxxxxxxxxxxxxxxsctrp') : address; },
    getPublicKey: async () => state.badKey ? Buffer.alloc(32, 9) : keyBytes,
    sign: async bytes => { state.signs++; state.signedBytes = Buffer.from(bytes); await pause('sign'); return Buffer.alloc(64, 1); },
  };
  const vault = {
    isUnlocked: () => state.unlocked,
    getWalletName: () => state.wallet,
    getSelectedIndex: () => state.index,
    getKeyPair: () => { if (!state.unlocked) throw Error('locked'); return state.key; },
    getSigningKeyPair: async () => { await pause('key'); return signer; },
  };
  const client = {};
  const zenon = {
    wsClient: client,
    ledger: {
      client,
      getFrontierBlock: async () => { state.fills++; await pause('prepare'); return { height: state.height, hash }; },
      getFrontierMomentum: async () => ({ height: 100 + state.height, hash }),
      getBlockByHash: async () => ({ toAddress: address }),
      publishRawTransaction: async template => { state.publishes.push(template.toJson()); },
    },
    embedded: { plasma: { client, getRequiredPoWForAccountBlock: async () => { await pause('pow'); return { requiredDifficulty: 0, basePlasma: 21000 }; } } },
  };
  const sdkFacade = { ...sdk, Zenon: { getSingleton: () => zenon, getChainIdentifier: () => state.chain } };
  const override = name => {
    if (name === 'znn-ts-sdk') return sdkFacade;
    if (name === './vault') return vault;
    if (name === '../utils/storage') return { getCurrentNodeUrl: () => state.node };
    return undefined;
  };
  const service = loadModules(override)('src/services/wallet/blockApproval.js');
  const prepare = (params = blockJson()) => service.prepareBlockApproval(params, { address: address.toString(), nodeUrl: state.node, isCurrent: () => state.current });
  const hold = phase => { state.pause = phase; state.gate = { started: deferred(), release: deferred() }; return state.gate; };
  return { state, zenon, vault, service, prepare, hold, override };
};

const elements = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(elements) : [tree, ...elements(tree.props?.children)];
const component = (f, first) => {
  const states = [first, null, false, false];
  const refs = [];
  let cursor = 0;
  let refCursor = 0;
  let effects = [];
  const errors = [];
  const mockReact = { ...React,
    useState: initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; },
    useRef: initial => { const i = refCursor++; return refs[i] ??= { current: initial }; },
    useCallback: fn => fn,
    useEffect: (fn, deps) => effects.push({ fn, deps }),
  };
  const Component = loadModules(name => {
    if (name === 'react') return mockReact;
    if (name === 'react-router-dom') return { useNavigate: () => () => {} };
    if (name === 'react-redux') return { useSelector: fn => fn({ wallet: { address: address.toString(), isUnlocked: f.state.unlocked }, connectionParameters: { chainIdentifier: f.state.chain, nodeUrl: f.state.node } }) };
    if (name.endsWith('/wallet/blockApproval')) return f.service;
    if (name.endsWith('/hooks/useAccount')) return () => ({ balanceMap: { [zts]: { balance: BigNumber.from('1000000000000'), token: { decimals: 8, symbol: 'ZNN' } } } });
    if (name.endsWith('/hooks/useBlockSender')) return () => ({ sendPrepared: f.service.sendBlockApproval, isSending: false, isGeneratingPlasma: false });
    if (name.endsWith('/wallet/signMessage')) return {};
    if (name.endsWith('/utils/messaging')) return { sendInternal: async type => type === 'approvals.next' ? { id: 'next', type: 'connect', params: {} } : null };
    if (name.endsWith('/utils/notify')) return { notify: { success() {}, error: err => errors.push(err) } };
    return f.override(name);
  })('src/layouts/siteIntegrationLayout/siteIntegrationLayout.js').default;
  const render = () => { cursor = 0; refCursor = 0; effects = []; return Component(); };
  const prepare = () => effects.find(effect => effect.deps?.length === 5 && effect.deps[0] === states[0]).fn();
  const unmount = () => effects.find(effect => effect.deps?.length === 0).fn()();
  return { states, errors, render, prepare, unmount };
};
const action = tree => elements(tree).find(el => el.type === 'button' && el.props.onClick?.name === 'approveSignAndSend');
const reject = tree => elements(tree).find(el => el.type === 'button' && el.props.children === 'Reject');
const request = (id, amount) => ({ id, type: 'signAndSendBlock', origin: 'https://example.invalid', params: blockJson(amount) });

(async () => {
  for (const initial of [undefined, null, { id: 'connect', type: 'connect', params: {} }]) {
    const f = fixture();
    const page = component(f, initial);
    const tree = page.render();
    assert(renderToStaticMarkup(tree));
    assert.equal(action(tree), undefined);
    assert.equal(f.state.signs, 0);
  }
  for (const type of ['send', 'receive', 'embedded']) {
    const f = fixture();
    let params = blockJson();
    if (type === 'receive') params = sdk.Primitives.AccountBlockTemplate.receive(hash).toJson();
    if (type === 'embedded') { params.toAddress = 'z1qxemdeddedxplasmaxxxxxxxxxxxxxxxxsctrp'; params.data = Buffer.from([1, 2, 3, 4]).toString('base64'); }
    const approval = await f.prepare(params);
    assert(Object.isFrozen(approval.block));
    assert(Object.isFrozen(approval.block.momentumAcknowledged));
    assert.throws(() => { approval.block.amount = '999'; }, TypeError);
    params.amount = '999';
    f.state.height = 8; // later frontier must not silently replace reviewed fields
    const sent = await f.service.sendBlockApproval(approval);
    assert.equal(f.state.fills, 1);
    assert.equal(sent.height, 5);
    assert.equal(sent.momentumAcknowledged.height, 104);
    assert.equal(sent.amount.toString(), approval.block.amount);
    assert.equal(sent.publicKey.toString('base64'), approval.block.publicKey);
    for (const [name, value] of Object.entries(approval.details)) assert.deepEqual(f.state.publishes[0][name], value);
    assert.equal(f.state.signs, 1);
    assert.equal(f.state.publishes.length, 1);
    await assert.rejects(f.service.sendBlockApproval(approval));
  }
  for (const explicit of [undefined, 123]) {
    const f = fixture();
    const params = blockJson();
    if (explicit === undefined) delete params.chainIdentifier; else params.chainIdentifier = explicit;
    const approval = await f.prepare(params);
    assert.equal(approval.block.chainIdentifier, explicit ?? 69);
    const sent = await f.service.sendBlockApproval(approval);
    assert.equal(sent.chainIdentifier, explicit ?? 69);
  }
  for (const invalidReceive of ['data', 'destination']) {
    const f = fixture();
    const params = sdk.Primitives.AccountBlockTemplate.receive(hash).toJson();
    if (invalidReceive === 'data') params.data = Buffer.from('not empty').toString('base64');
    else f.zenon.ledger.getBlockByHash = async () => ({ toAddress: sdk.Primitives.Address.parse('z1qxemdeddedxplasmaxxxxxxxxxxxxxxxxsctrp') });
    await assert.rejects(f.prepare(params));
    assert.equal(f.state.signs, 0);
  }
  const mutations = [
    f => { f.state.current = false; }, f => { f.state.unlocked = false; },
    f => { f.state.index = 1; }, f => { f.state.wallet = 'different'; },
    f => { f.state.key = { ...f.state.key }; }, f => { f.state.chain = 2; },
    f => { f.state.node = 'wss://other.invalid'; }, f => { f.zenon.wsClient = {}; },
    f => { f.zenon.ledger.client = {}; }, f => { f.zenon.embedded.plasma.client = {}; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    const approval = await f.prepare();
    mutate(f);
    assert.equal(f.service.isCurrentBlockApproval(approval), false);
    await assert.rejects(f.service.sendBlockApproval(approval));
    assert.equal(f.state.signs, 0);
    assert.equal(f.state.publishes.length, 0);
  }
  for (const phase of ['prepare', 'key', 'signer', 'pow', 'sign']) {
    const f = fixture();
    const approval = phase === 'prepare' ? null : await f.prepare();
    const gate = f.hold(phase);
    const operation = phase === 'prepare' ? f.prepare() : f.service.sendBlockApproval(approval);
    await gate.started.promise;
    f.state.current = false;
    gate.release.resolve();
    await assert.rejects(operation);
    assert.equal(f.state.signs, phase === 'sign' ? 1 : 0);
    assert.equal(f.state.publishes.length, 0);
  }
  for (const mismatch of ['badKey', 'badAddress']) {
    const f = fixture();
    const approval = await f.prepare();
    f.state[mismatch] = true;
    await assert.rejects(f.service.sendBlockApproval(approval));
    assert.equal(f.state.signs, 0);
  }
  {
    const f = fixture();
    const approval = await f.prepare();
    const gate = f.hold('key');
    const first = f.service.sendBlockApproval(approval);
    await gate.started.promise;
    await assert.rejects(f.service.sendBlockApproval(approval));
    gate.release.resolve();
    await first;
    assert.equal(f.state.signs, 1);
  }
  // Actual JSX/effect/callback regression for A -> B, including the render
  // before B's effect and then B's pending preparation. Real SDK fills/signs.
  {
    const f = fixture();
    const page = component(f, request('A', '100000000'));
    assert.equal(action(page.render()).props.disabled, true);
    page.prepare(); await tick();
    assert(renderToStaticMarkup(page.render()).includes('1 ZNN'));
    page.states[0] = request('B', '10000000000');
    const beforeEffect = page.render();
    assert(!renderToStaticMarkup(beforeEffect).includes('1 ZNN'));
    assert.equal(action(beforeEffect).props.disabled, true);
    await action(beforeEffect).props.onClick();
    assert.equal(f.state.signs, 0);
    const gate = f.hold('prepare');
    page.prepare(); await gate.started.promise;
    assert.equal(action(page.render()).props.disabled, true);
    gate.release.resolve(); await tick();
    const ready = page.render();
    assert(renderToStaticMarkup(ready).includes('100 ZNN'));
    assert.equal(action(ready).props.disabled, false);
    const signing = f.hold('key');
    const first = action(ready).props.onClick();
    await signing.started.promise;
    assert(renderToStaticMarkup(page.render()).includes('100 ZNN'));
    await action(ready).props.onClick();
    await reject(ready).props.onClick(); // reject cannot advance during a send
    assert.equal(page.states[0].id, 'B');
    signing.release.resolve(); await first;
    assert.equal(f.state.signs, 1);
    assert.equal(f.state.publishes[0].amount, '10000000000');
    assert.equal(page.errors.length, 0);
  }
  for (const scenario of ['failed', 'outOfOrder', 'unmount', 'reject']) {
    const f = fixture();
    const page = component(f, request('A', '100000000'));
    const gate = f.hold('prepare');
    page.render(); page.prepare(); await gate.started.promise;
    if (scenario === 'outOfOrder') {
      f.state.pause = null;
      page.states[0] = request('B', '200000000');
      page.render(); page.prepare(); await tick();
      gate.release.resolve(); await tick();
      const html = renderToStaticMarkup(page.render());
      assert(html.includes('2 ZNN') && !html.includes('1 ZNN'));
    } else if (scenario === 'failed') {
      gate.release.reject(Error('node unavailable')); await tick();
      const tree = page.render();
      assert(renderToStaticMarkup(tree).includes('Unable to prepare'));
      assert.equal(action(tree).props.disabled, true);
      await action(tree).props.onClick();
    } else if (scenario === 'unmount') {
      page.unmount(); gate.release.resolve(); await tick();
      assert.equal(page.states[1], null);
    } else {
      await reject(page.render()).props.onClick();
      gate.release.resolve(); await tick();
      assert.equal(page.states[1], null);
    }
    assert.equal(f.state.signs, 0);
    assert.equal(f.state.publishes.length, 0);
  }
  console.log('block approval: exact prepared fields, real SDK send/receive/embedded controls, current-context guards, delayed lifecycle, single use, signer identity and actual JSX race regression passed');
})().catch(err => { console.error(String(err)); console.error(err.stack?.split('\n').slice(0, 6).join('\n')); process.exitCode = 1; });
