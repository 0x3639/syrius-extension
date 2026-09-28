'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const babel = require('@babel/core');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// Exercise the installed browser SDK with isolated storage, no node connection.
global.window = { crypto: require('node:crypto').webcrypto };
const memory = new Map();
global.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)) };
const sdk = require('znn-ts-sdk');
const { ethers } = require('ethers');
const root = path.join(__dirname, '..');
const loader = (override = () => undefined) => {
  const cache = new Map();
  const load = (file) => {
    const filename = path.resolve(root, file);
    if (cache.has(filename)) return cache.get(filename);
    const mod = { exports: {} };
    cache.set(filename, mod.exports);
    const { code } = babel.transformFileSync(filename, {
      presets: [['@babel/preset-env', { targets: { node: 'current' } }], '@babel/preset-react'],
      babelrc: false, configFile: false,
    });
    const resolve = (name) => {
      const replacement = override(name);
      if (replacement !== undefined) return replacement;
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
const load = loader();
const { withBaseTokens, fetchBalances } = load('src/services/wallet/account.js');
const { znnZts, qsrZts, normalizeBaseUnits, authorizationMetadata, parseTransferAmount, prepareTransfer } = load('src/services/wallet/tokenMetadata.js');
const { parseAmount } = load('src/services/utils/format.js');
const TokenAmount = load('src/components/token-amount/token-amount.js').default;
const custom = new sdk.Primitives.TokenStandard(Buffer.alloc(10, 7)).toString();
const recipient = 'z1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsggv2f';
const enough = ethers.BigNumber.from('100000000000000000000');
const entry = (zts, decimals, symbol = 'FORGED') => ({ balance: enough, token: { tokenStandard: zts, decimals, symbol, name: 'Forged name', verified: true } });

// Render the actual Send/approval component, controlling only browser hooks and
// side effects. The real policy, amount component, and SDK constructors execute.
const view = ({ file, states, account }) => {
  let cursor = 0;
  let refCursor = 0;
  let modal;
  const refs = [];
  const sent = [];
  const errors = [];
  const rules = {};
  const mockReact = { ...React,
    useState: initial => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; },
    useRef: initial => { const i = refCursor++; return refs[i] ??= { current: initial }; },
    useMemo: fn => fn(), useEffect: () => {}, useCallback: fn => fn,
    useContext: () => ({ openModal: value => { modal = value; } }),
  };
  const Component = loader(name => {
    if (name === 'react') return mockReact;
    if (name === 'react-router-dom') return { useNavigate: () => () => {}, useLocation: () => ({}) };
    if (name === 'react-redux') return { useSelector: fn => fn({ wallet: { address: account.address, isUnlocked: true }, connectionParameters: { chainIdentifier: 1, nodeUrl: 'wss://example.invalid' } }) };
    if (name === 'react-hook-form') return { useForm: () => ({ register: (name, options) => { rules[name] = options; return { name }; }, handleSubmit: fn => fn, formState: { errors: {} }, reset: () => {}, setValue: () => {}, trigger: () => {} }) };
    if (name.endsWith('/hooks/useAccount')) return () => account;
    if (name.endsWith('/hooks/useBackgroundSender')) return () => ({ sendInBackground: template => sent.push(template) });
    if (name.endsWith('/hooks/useBlockSender')) return () => ({ send: async template => { sent.push(template); return template; }, isSending: false, isGeneratingPlasma: false });
    if (name.endsWith('/hooks/modal/modalContext')) return { ModalContext: {} };
    if (name.endsWith('/wallet/vault')) return {};
    if (name.endsWith('/wallet/signMessage')) return {};
    if (name.endsWith('/utils/messaging')) return { sendInternal: async type => type === 'approvals.next' ? { id: 'next', type: 'connect', params: {} } : null };
    if (name.endsWith('/utils/notify')) return { notify: { error: err => errors.push(err), success: () => {} } };
    if (name.includes('/components/modals/') || name.includes('/components/custom-dropdown/')) return () => null;
    return undefined;
  })(file).default;
  return { render: () => { cursor = 0; refCursor = 0; return Component(); }, sent, errors, rules, modal: () => modal };
};
const elements = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(elements) : [tree, ...elements(tree.props?.children)];
const sendFile = 'src/pages/send-receive/send/send.js';
const approvalFile = 'src/layouts/siteIntegrationLayout/siteIntegrationLayout.js';

(async () => {
  for (const decimals of [0, 10, 30, '10', undefined]) {
    const rpc = { [znnZts]: entry(custom, decimals), [qsrZts]: entry(znnZts, decimals) };
    const { balanceMap } = await fetchBalances({ ledger: { getAccountInfoByAddress: async () => ({ balanceInfoMap: rpc }) } }, {});
    for (const [zts, symbol] of [[znnZts, 'ZNN'], [qsrZts, 'QSR']]) {
      assert.equal(balanceMap[zts].token.decimals, 8);
      assert.equal(balanceMap[zts].token.symbol, symbol);
      assert.equal(balanceMap[zts].token.tokenStandard, zts);
      assert.equal(balanceMap[zts].balance, enough);
      assert(Object.isFrozen(balanceMap[zts].token));
    }
    const destination = sdk.Primitives.Address.parse(recipient);
    const send = sdk.Primitives.AccountBlockTemplate.send(destination, sdk.Primitives.TokenStandard.parse(znnZts), parseAmount('1.00000001', balanceMap[znnZts].token.decimals));
    const stake = sdk.Zenon.getSingleton().embedded.stake.stake(2592000, parseAmount('1', balanceMap[znnZts].token.decimals));
    const fuse = await sdk.Zenon.getSingleton().embedded.plasma.fuse(destination, parseAmount('10.12345678', balanceMap[qsrZts].token.decimals));
    assert.equal(send.amount.toString(), '100000001');
    assert.equal(stake.amount.toString(), '100000000');
    assert.equal(fuse.amount.toString(), '1012345678');
    rpc[znnZts].token.decimals = 1;
    assert.equal(balanceMap[znnZts].token.decimals, 8);
  }
  assert.equal(withBaseTokens({})[znnZts].balance, 0);
  assert.equal(withBaseTokens({ [znnZts.toUpperCase()]: entry(custom, 30) })[znnZts].token.decimals, 8);
  assert.throws(() => withBaseTokens({ [custom]: entry(znnZts, 8) }));
  assert.throws(() => withBaseTokens({ invalid: entry(custom, 8) }));
  assert.throws(() => withBaseTokens({ [custom]: entry(custom, 8), [custom.toUpperCase()]: entry(custom, 8) }));
  assert.throws(() => withBaseTokens({ [custom]: entry(custom, JSON.parse('{"type":"BigNumber","hex":"0x08","toString":"invalid"}')) }), /invalid token decimals/);
  assert.equal(withBaseTokens({ [custom]: entry(custom, '8') })[custom].token.decimals, 8);
  assert.equal(authorizationMetadata(custom).isNative, false);
  for (const input of ['1.1', '1.0', '1e3', '-1', '.', '']) assert.equal(parseTransferAmount(input, custom), null);
  const exact = '9007199254740993';
  assert.equal(parseTransferAmount(exact, custom).toString(), exact);
  const snapshot = prepareTransfer({ tokenStandard: custom, amount: exact, recipient, owner: recipient, balance: enough });
  assert(Object.isFrozen(snapshot));
  assert.equal(snapshot.amount, exact);
  assert.throws(() => { snapshot.amount = '1'; }, TypeError);

  for (const [zts, amount, expected] of [[znnZts, '1.00000001', '100000001'], [custom, exact, exact]]) {
    const rpc = { [zts]: entry(zts, 30, 'ZNN') };
    const account = { address: recipient, ...await fetchBalances({ ledger: { getAccountInfoByAddress: async () => ({ balanceInfoMap: rpc }) } }, {}) };
    const page = view({ file: sendFile, states: [zts, amount, recipient], account });
    elements(page.render()).find(el => el.type === 'form').props.onSubmit();
    const modal = page.modal();
    const html = renderToStaticMarkup(modal.props.children);
    assert(html.includes(zts));
    assert(html.includes(expected));
    if (zts === custom) assert(html.includes('base units') && html.includes('Unverified'));
    else assert(html.includes('1.00000001 ZNN'));
    rpc[zts].token.decimals = 0;
    rpc[zts].token.tokenStandard = qsrZts;
    page.render();
    modal.props.onSuccess();
    assert.equal(page.sent.length, 1);
    assert.equal(page.sent[0].amount.toString(), expected);
    assert.equal(page.sent[0].tokenStandard.toString(), zts);
    assert.equal(page.sent[0].toAddress.toString(), recipient);
    assert.equal(page.errors.length, 0);
  }
  const account = { address: recipient, balanceMap: withBaseTokens({ [custom]: entry(custom, 10) }), balances: [] };
  const invalid = view({ file: sendFile, states: [custom, '1.2', recipient], account });
  elements(invalid.render()).find(el => el.type === 'form').props.onSubmit();
  assert.equal(invalid.modal(), undefined);
  assert.equal(invalid.sent.length, 0);
  const switched = view({ file: sendFile, states: [custom, '1', recipient], account });
  elements(switched.render()).find(el => el.type === 'form').props.onSubmit();
  const modal = switched.modal();
  account.address = 'different account';
  switched.render();
  modal.props.onSuccess();
  assert.equal(switched.sent.length, 0);

  for (const type of ['sendTransaction', 'signAndSendBlock']) {
    for (const zts of [znnZts, custom]) {
      for (const destination of [recipient, 'z1qxemdeddedxplasmaxxxxxxxxxxxxxxxxsctrp']) {
        const amount = zts === custom ? exact : '100000001';
        const request = { id: 'fixture', type, origin: 'https://example.invalid', params: { amount, tokenStandard: zts, to: destination, toAddress: destination, data: '' } };
        // Deliberately supply hostile metadata directly, bypassing normalization:
        // amount rendering must enforce its own trust boundary too.
        const page = view({ file: approvalFile, states: [request, null, false, false], account: { address: recipient, balanceMap: { [zts]: entry(zts, 30, 'FORGED') } } });
        const html = renderToStaticMarkup(page.render());
        assert(html.includes(zts));
        assert(html.includes(amount));
        assert(!html.includes('FORGED'));
        assert(html.includes(zts === custom ? 'base units' : '1.00000001 ZNN'));
      }
    }
  }
  // The SDK accepts hex and BigNumberish quantities. The display and the
  // actual signing handlers must normalize each to the same integer units.
  for (const type of ['sendTransaction', 'signAndSendBlock']) {
    for (const amount of ['0x05f5e100', '0100000000', 100000000, ethers.BigNumber.from(100000000), { type: 'BigNumber', hex: '0x05f5e100' }]) {
      assert.equal(normalizeBaseUnits(amount), '100000000');
      const params = { ...sdk.Primitives.AccountBlockTemplate.send(sdk.Primitives.Address.parse(recipient), sdk.Primitives.TokenStandard.parse(znnZts), ethers.BigNumber.from(1)).toJson(), to: recipient, amount };
      const request = { id: 'encoded', type, params };
      const page = view({ file: approvalFile, states: [request, null, false, false], account: { address: recipient, balanceMap: withBaseTokens({ [znnZts]: entry(znnZts, 30) }) } });
      const tree = page.render();
      assert(renderToStaticMarkup(tree).includes('1.0 ZNN'));
      const button = elements(tree).find(el => el.type === 'button' && el.props.children !== 'Reject');
      assert.equal(button.props.disabled, false);
      await button.props.onClick();
      assert.equal(page.sent.length, 1);
      assert.equal(page.sent[0].amount.toString(), '100000000');
      assert.equal(page.errors.length, 0);
    }
    for (const amount of ['-1', '-0x01', '1.1', '1e8', '', null, undefined, Number.MAX_SAFE_INTEGER + 1, { toString: 'invalid' }]) {
      assert.throws(() => normalizeBaseUnits(amount));
      const request = { id: 'invalid', type, params: { to: recipient, tokenStandard: znnZts, amount } };
      const page = view({ file: approvalFile, states: [request, null, false, false], account: { address: recipient, balanceMap: withBaseTokens({ [znnZts]: entry(znnZts, 8) }) } });
      const tree = page.render();
      const button = elements(tree).find(el => el.type === 'button' && el.props.children !== 'Reject');
      assert.equal(button.props.disabled, true);
      await button.props.onClick(); // final handler also refuses a bypassed UI
      assert.equal(page.sent.length, 0);
      assert.equal(page.errors.length, 1);
    }
  }
  assert(renderToStaticMarkup(React.createElement(TokenAmount, { amount: { toString: 'invalid' }, tokenStandard: 'invalid' })).includes('Invalid amount'));
  console.log('token metadata: canonical SDK units, integer custom sends, immutable confirmations, identity validation and both dApp displays passed');
})().catch(err => { console.error(String(err)); console.error(err.stack?.split('\n').slice(0,5).join('\n')); process.exitCode = 1; });
