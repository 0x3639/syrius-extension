#!/usr/bin/env node
//
// Dev harness for the extension.
//
// It runs a Chrome of its own - own profile, own port, this repo's build loaded
// unpacked - holding a throwaway wallet that unlocks itself. The browser is
// started detached and outlives every command below, so a screen can be opened
// once and then poked at one command at a time instead of being clicked through
// from the splash each time.
//
//   node utils/dev-harness.js start [--route tabs/settings/change-node]
//   node utils/dev-harness.js route tabs/settings/change-node
//   node utils/dev-harness.js shot [--out name.png] [--full]
//   node utils/dev-harness.js text [selector]
//   node utils/dev-harness.js click "<selector>"
//   node utils/dev-harness.js fill "<selector>" "<value>"
//   node utils/dev-harness.js eval "<expression>"
//   node utils/dev-harness.js logs [--clear]
//   node utils/dev-harness.js reload [--no-build]
//   node utils/dev-harness.js build
//   node utils/dev-harness.js status
//   node utils/dev-harness.js stop
//
// And a dApp in the same browser, with the wallet's approvals answered from
// here rather than clicked:
//
//   node utils/dev-harness.js open <url>
//   node utils/dev-harness.js page goto <url> [--url <part of the page's address>]
//   node utils/dev-harness.js page reload [--hard]
//   node utils/dev-harness.js page text|click|fill|eval ... [--shot]
//   node utils/dev-harness.js page shot [--out name.png] [--full]
//   node utils/dev-harness.js approvals
//   node utils/dev-harness.js approve [--expect connect|signMessage|signAndSendBlock|sendTransaction] [--timeout 60]
//   node utils/dev-harness.js reject [--timeout 60]
//
// `approve` prints the approval screen before it presses anything, and refuses
// unless the wallet's node is on this machine and its chain is not mainnet's.
//
// Two sides of a trade need two wallets that cannot see each other, which means
// two browsers: `--instance <name>` on every command gives each its own profile,
// wallet, port and screenshots, and `--address-index` at `start` is what makes
// the second one somebody else.
//
//   node utils/dev-harness.js start --instance b --address-index 2
//   node utils/dev-harness.js open --instance b http://127.0.0.1:4175/
//   node utils/dev-harness.js approve --instance b --expect signAndSendBlock
//
// A selector is css, or text=<what the element says> for the unlabelled divs
// this wallet uses as buttons.
//
// The wallet it unlocks is the go-zenon devnet one, written to
// .dev-harness/wallet.json (git ignored) on first run - edit that file to point
// the harness at another mnemonic, node or address index.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const buildDir = path.join(repoRoot, 'build');

// Which harness this is.
//
// A two-sided test needs two wallets that cannot see each other, and a wallet
// lives in a browser profile — so an instance is a whole harness of its own:
// its own profile, wallet, state, screenshots and debugging port. Unnamed is
// the original one, so everything written before this keeps working.
const instanceFlag = process.argv.indexOf('--instance');
const instance = (instanceFlag !== -1 ? process.argv[instanceFlag + 1] : process.env.SYRIUS_DEV_INSTANCE || '').trim();

if (instance && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(instance)) {
  console.error(`Not a usable instance name: ${JSON.stringify(instance)}. Lower-case letters, digits and dashes.`);
  process.exit(1);
}

const harnessDir = path.join(repoRoot, instance ? `.dev-harness-${instance}` : '.dev-harness');
const profileDir = path.join(harnessDir, 'chrome-profile');
const walletFile = path.join(harnessDir, 'wallet.json');
const stateFile = path.join(harnessDir, 'state.json');
const shotsDir = path.join(harnessDir, 'shots');

// One port per instance, derived from the name rather than remembered, so that
// every later command finds that instance's browser without being told which
// port it landed on.
const portForInstance = (name) => {
  let hash = 5381;

  for (const character of name) {
    hash = ((hash * 33) ^ character.charCodeAt(0)) >>> 0;
  }
  return 9223 + (hash % 100);
};

const portFlag = process.argv.indexOf('--port');
const debugPort = Number(
  (portFlag !== -1 && process.argv[portFlag + 1]) ||
  process.env.SYRIUS_DEV_PORT ||
  (instance ? portForInstance(instance) : 9222));

// The go-zenon devnet in ../go-zenon/docker/devnet: chain 69, funded dev
// addresses, and a mnemonic that repo commits precisely so that it can be used
// like this. Nothing here is a key worth protecting, and none of it is on
// mainnet. Override with --node / --mnemonic, or by editing
// .dev-harness/wallet.json.
const defaultNodeUrl = process.env.SYRIUS_DEV_NODE_URL || 'ws://localhost:35998';
const devnetWallet = {
  walletName: 'devnet',
  password: 'devnet',
  mnemonic: 'abstract affair idle position alien fluid board ordinary exist afraid chapter wood ' +
    'wood guide sun walnut crew perfect place firm poverty model side million',
  // Index 1 of that mnemonic - the general dev wallet holding 10,000 ZNN and
  // 100,000 QSR. Index 0 is a pillar producer with nothing on it.
  addressIndex: 1,
  nodeUrl: defaultNodeUrl,
  // The chain identifier is signed into every block, and the devnet's is 69.
  // Without this the harness signed for mainnet's chain 1 and the node
  // rejected everything it sent.
  chainId: Number(process.env.SYRIUS_DEV_CHAIN_ID || 69),
};
// The popup is pinned to 360px wide by the stylesheet; the height is what a
// Chrome popup gets at most.
const popupViewport = { width: 360, height: 600 };
const devWalletConfigKey = 'znn.dev-autounlock';

//
// Small talk with the DevTools protocol. One socket, ids in, events out; page
// commands ride the same socket under a session id.
//
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.socket.onmessage = (event) => this.receive(event.data);
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onopen = () => resolve(new Cdp(socket));
      socket.onerror = () => reject(new Error(`Could not open a debugging connection to ${url}`));
    });
  }

  receive(data) {
    const message = JSON.parse(data);
    const waiting = this.pending.get(message.id);

    if (!waiting) {
      return;
    }
    this.pending.delete(message.id);

    if (message.error) {
      waiting.reject(new Error(`${message.error.message || 'protocol error'} (${JSON.stringify(message.error.data || '')})`));
    } else {
      waiting.resolve(message.result);
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const message = { id, method, params };

    if (sessionId) {
      message.sessionId = sessionId;
    }
    this.socket.send(JSON.stringify(message));

    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() {
    this.socket.close();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const findChrome = () => {
  const candidates = [
    process.env.SYRIUS_CHROME,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);

  const found = candidates.find((candidate) => fs.existsSync(candidate));

  if (!found) {
    throw new Error('No Chrome found. Point SYRIUS_CHROME at one.');
  }
  return found;
}

// The wallet the harness unlocks. Written out on first run so it can be edited
// - drop in another mnemonic, node or address index and every later command
// picks it up. The extension side turns it into a real keystore inside the
// browser profile.
const loadWalletConfig = (overrides = {}) => {
  const config = { ...(readJson(walletFile, null) || devnetWallet), ...overrides };

  writeJson(walletFile, config);
  return config;
}

//
// Runs in the popup before any of its own scripts do: leaves the auto-unlock
// config where the extension looks for it, and keeps a copy of everything the
// page logs, since each command here is its own short-lived process and would
// otherwise only ever see what happened after it attached.
//
const bootstrapSource = (walletConfig) => `
(() => {
  try {
    localStorage.setItem(${JSON.stringify(devWalletConfigKey)}, ${JSON.stringify(JSON.stringify(walletConfig))});
  } catch (err) {}

  if (window.__syriusHarness) {
    return;
  }

  const entries = [];
  const describe = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || (value.name + ': ' + value.message);
    try { return JSON.stringify(value); } catch (err) { return String(value); }
  };
  const record = (level, args) => {
    entries.push({ level: level, at: new Date().toISOString(), text: args.map(describe).join(' ') });
    if (entries.length > 500) entries.shift();
  };

  window.__syriusHarness = { entries: entries };

  ['log', 'info', 'warn', 'error'].forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args) => { record(level, args); original(...args); };
  });

  window.addEventListener('error', (event) => record('error', [event.message, event.filename + ':' + event.lineno]));
  window.addEventListener('unhandledrejection', (event) => record('error', ['unhandled rejection', event.reason]));
})();
`;

const runBuild = () => {
  return new Promise((resolve, reject) => {
    // Read by webpack.config.js as it is required, so both have to be set first.
    process.env.BABEL_ENV = 'development';
    process.env.NODE_ENV = 'development';
    process.env.ASSET_PATH = '/';
    process.env.SYRIUS_DEV_WALLET = 'true';

    const webpack = require('webpack');
    const config = require('../webpack.config');

    delete config.chromeExtensionBoilerplate;
    config.mode = 'development';

    console.log('Building a dev bundle with auto-unlock ...');

    webpack(config, (err, stats) => {
      if (err) {
        return reject(err);
      }
      if (stats.hasErrors()) {
        return reject(new Error(stats.toString({ colors: false, all: false, errors: true })));
      }
      console.log('Build done.');
      resolve();
    });
  });
}

const isChromeUp = async () => {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? await response.json() : null;
  } catch (err) {
    return null;
  }
}

const launchChrome = async () => {
  const running = await isChromeUp();

  if (running) {
    return running;
  }

  if (!fs.existsSync(path.join(buildDir, 'manifest.json'))) {
    throw new Error('build/ has no extension in it. Run `npm run dev:build` first.');
  }

  fs.mkdirSync(profileDir, { recursive: true });

  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    // What lets the extension be installed over the protocol below, rather
    // than through --load-extension, which current Chrome ignores.
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-session-crashed-bubble',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });

  chrome.unref();

  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(500);
    const version = await isChromeUp();

    if (version) {
      writeJson(stateFile, { ...readJson(stateFile, {}), pid: chrome.pid, port: debugPort });
      return version;
    }
  }
  throw new Error('Chrome did not come up with debugging enabled.');
}

// Chrome runs component extensions of its own, so ours has to be picked out by
// a file only it has rather than by being the one extension in the browser.
// The popup is a BrowserRouter and rewrites its own path as it goes, so an
// already known id counts for more than the url that is on screen right now.
const ownExtensionFromTargets = async (cdp) => {
  const remembered = readJson(stateFile, {}).extensionId;
  const { targetInfos } = await cdp.send('Target.getTargets');

  const own = targetInfos.find((target) => {
    if (!target.url.startsWith('chrome-extension://')) {
      return false;
    }
    if (remembered && new URL(target.url).host === remembered) {
      return true;
    }
    return target.url.endsWith('/background.bundle.js') || target.url.includes('/popup.html');
  });

  return own ? new URL(own.url).host : null;
}

// Installing it over the protocol is what makes the id knowable at all, and
// asking twice for the same directory is answered with the same id, so this is
// also how a rebuilt service worker and manifest get picked up. It is skipped
// while a live target says the extension is already loaded, because a reload
// there would throw away the popup that is being looked at.
const loadExtension = async (cdp, { force = false } = {}) => {
  if (!force) {
    const alreadyLoaded = await ownExtensionFromTargets(cdp);

    if (alreadyLoaded) {
      return alreadyLoaded;
    }
  }

  if (!fs.existsSync(path.join(buildDir, 'manifest.json'))) {
    throw new Error('build/ has no extension in it. Run `npm run dev:build` first.');
  }

  try {
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: buildDir });
    writeJson(stateFile, { ...readJson(stateFile, {}), extensionId: id });
    return id;
  }
  catch (err) {
    const remembered = readJson(stateFile, {}).extensionId;

    if (remembered) {
      return remembered;
    }
    throw new Error(`Chrome would not load build/ as an extension: ${err.message}`);
  }
}

class Popup {
  constructor(cdp, sessionId, url, origin) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.url = url;
    this.origin = origin;
  }

  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });

    if (result.exceptionDetails) {
      const thrown = result.exceptionDetails.exception;
      throw new Error(thrown?.description || thrown?.value || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async waitFor(expression, { timeout = 60000, interval = 250 } = {}) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) {
          return true;
        }
      } catch (err) {
        // The page can be mid-navigation, in which case asking again is the
        // whole of the recovery.
      }
      await sleep(interval);
    }
    return false;
  }

  // A tab already on the extension's own origin can be sent round again. One
  // that is not cannot be pointed at an extension page at all - Chrome refuses
  // the cross origin navigation and reports the page as missing - which is why
  // tabs here are always created straight onto the popup.
  async navigate() {
    const here = String(await this.evaluate('location.href').catch(() => ''));

    if (!here.startsWith(this.origin)) {
      throw new Error(`The popup tab wandered off to ${here || 'nowhere'}; close it and start again.`);
    }
    await this.send('Page.navigate', { url: this.url });
    await sleep(500);
  }
}

const attach = async ({ navigate = false, reloadExtension = false, walletOverrides = {} } = {}) => {
  const version = await launchChrome();
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  const extensionId = await loadExtension(cdp, { force: reloadExtension });
  const extensionOrigin = `chrome-extension://${extensionId}/`;
  const popupUrl = extensionOrigin + 'popup.html';

  // Found by origin rather than by url: the popup rewrites its own path as it
  // routes, so by the time a second command runs the tab is no longer sitting
  // on popup.html and looking for that url opens a second tab every time.
  //
  // An approval window is on the same origin but is not the popup, and it is
  // left alone: closing it is the wallet's "no", so tidying it away here would
  // reject whatever a page is waiting on, and adopting it as the popup would
  // navigate it off the request.
  const { targetInfos } = await cdp.send('Target.getTargets');
  const openPopups = targetInfos.filter((target) =>
    target.type === 'page' && target.url.startsWith(extensionOrigin) && !target.url.includes(approvalHash));

  for (const extra of openPopups.slice(1)) {
    await cdp.send('Target.closeTarget', { targetId: extra.targetId });
  }

  let targetId = openPopups[0]?.targetId;

  if (!targetId) {
    // Opened straight onto the popup: a tab has to be put on the extension's
    // origin by the browser, because no page is allowed to navigate to it.
    ({ targetId } = await cdp.send('Target.createTarget', { url: popupUrl }));
    navigate = true;
  }

  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const popup = new Popup(cdp, sessionId, popupUrl, extensionOrigin);

  await popup.send('Page.enable');
  await popup.send('Runtime.enable');
  await setViewport(popup);
  await popup.send('Page.addScriptToEvaluateOnNewDocument', {
    source: bootstrapSource(loadWalletConfig(walletOverrides)),
  });

  if (navigate) {
    await popup.navigate();
  }
  return { cdp, popup, extensionId };
}

// Unlocking means decrypting a keystore and opening a websocket to a real node,
// neither of which is instant, so this waits for the tabs layout the wallet
// lands on and explains itself if it never shows up.
const waitForUnlock = async (popup) => {
  const ready = await popup.waitFor("!!document.querySelector('.menu-layout')", { timeout: 90000 });

  if (ready) {
    return true;
  }

  const isDevBuild = await popup.evaluate("typeof window.__syriusDevNavigate === 'function'").catch(() => false);
  const screen = await popup.evaluate("(document.body.innerText || '').trim().slice(0, 300)").catch(() => '');

  if (!isDevBuild) {
    console.error('The extension in build/ is not a dev build - run `npm run dev:build` (or `start` without --no-build).');
  }
  console.error('The wallet did not unlock. The popup is showing:\n' + screen);
  return false;
}

const routeTo = async (popup, route) => {
  const path = route.startsWith('/') ? route : '/' + route;

  await popup.evaluate(`window.__syriusDevNavigate(${JSON.stringify(path)})`);
  await sleep(400);
}

const setViewport = (popup, height) => popup.send('Emulation.setDeviceMetricsOverride', {
  ...popupViewport,
  height: height || popupViewport.height,
  deviceScaleFactor: 2,
  mobile: false,
});

// The popup never scrolls the document - it scrolls a pane held at the height a
// Chrome popup gets - so a taller window on its own captures nothing new, and
// "beyond the viewport" finds nothing beyond it. What does work is letting that
// pane stand at its full height for the one frame being photographed.
const expandScroller = (popup) => popup.evaluate(`(() => {
  const scroller = Array.from(document.querySelectorAll('*')).find((element) => {
    const overflow = getComputedStyle(element).overflowY;
    return (overflow === 'auto' || overflow === 'scroll') && element.scrollHeight > element.clientHeight + 1;
  });

  if (!scroller) {
    return document.documentElement.scrollHeight;
  }

  window.__syriusExpanded = { scroller: scroller, height: scroller.style.height, overflowY: scroller.style.overflowY };
  const height = Math.min(scroller.scrollHeight, 4000);
  scroller.style.height = height + 'px';
  scroller.style.overflowY = 'visible';
  return height;
})()`);

const restoreScroller = (popup) => popup.evaluate(`(() => {
  const expanded = window.__syriusExpanded;
  if (!expanded) return null;
  expanded.scroller.style.height = expanded.height;
  expanded.scroller.style.overflowY = expanded.overflowY;
  delete window.__syriusExpanded;
  return true;
})()`);

const screenshot = async (popup, { out, full }) => {
  fs.mkdirSync(shotsDir, { recursive: true });

  const file = path.isAbsolute(out || '') ? out : path.join(shotsDir, out || `popup-${Date.now()}.png`);

  if (full) {
    const height = await expandScroller(popup);
    await setViewport(popup, Math.max(popupViewport.height, height));
    await sleep(250);
  }

  const { data } = await popup.send('Page.captureScreenshot', { format: 'png' });

  if (full) {
    await restoreScroller(popup);
    await setViewport(popup);
  }

  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

// Most of this wallet's buttons are unlabelled divs that only differ by what
// they say, so a selector can also be given as text=Use chain 69 - the deepest
// element whose own text is that, which is the button rather than the card
// around it.
const elementFor = (selector) => {
  if (!selector) {
    throw new Error('Which element? Pass a css selector, or text=<what it says>.');
  }

  if (!selector.startsWith('text=')) {
    return `document.querySelector(${JSON.stringify(selector)})`;
  }

  const wanted = selector.slice('text='.length);

  return `(() => {
    const wanted = ${JSON.stringify(wanted)}.trim().toLowerCase();
    const matches = Array.from(document.querySelectorAll('body *')).filter((element) =>
      (element.innerText || element.value || '').trim().toLowerCase() === wanted);
    return matches[matches.length - 1] || null;
  })()`;
}

const parseArgs = (argv) => {
  const flags = {};
  const positional = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (argument.startsWith('--')) {
      const name = argument.slice(2);
      const next = argv[index + 1];

      if (!next || next.startsWith('--')) {
        flags[name] = true;
      } else {
        flags[name] = next;
        index++;
      }
    } else {
      positional.push(argument);
    }
  }
  return { flags, positional };
}

//
// Ordinary pages - a dApp under test - driven in the same browser as the wallet.
//
// The content scripts are declared for every http and https page, so a page
// opened here gets the provider exactly as it would in a real profile, and its
// requests land in the same approval window a person would see. Which page the
// `page` commands act on is remembered in state.json; --url picks another by a
// piece of its address.
//
const approvalHash = '#/site-integration';

const findPageTarget = async (cdp, flags) => {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const pages = targetInfos.filter((target) =>
    target.type === 'page' && /^https?:/.test(target.url));

  if (typeof flags.url === 'string') {
    const match = pages.find((target) => target.url.includes(flags.url));

    if (!match) {
      throw new Error(`No open page has ${flags.url} in its address. Open: ${pages.map((t) => t.url).join(', ') || '(none)'}`);
    }
    return match;
  }

  const remembered = readJson(stateFile, {}).pageTargetId;
  const match = pages.find((target) => target.targetId === remembered);

  if (!match) {
    throw new Error('No page is open. Run `open <url>` first, or pass --url.');
  }
  return match;
}

// A page is driven through the same wrapper as the popup; only the popup's own
// navigation rules do not apply to it, and nothing here calls them.
const attachToPage = async (cdp, target) => {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const page = new Popup(cdp, sessionId, target.url, new URL(target.url).origin);

  page.targetId = target.targetId;
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  return page;
}

// A tab Chrome is not showing may never produce a frame, which leaves a
// screenshot waiting forever, so the page is brought to the front first.
const pageScreenshot = async (page, { out, full }) => {
  fs.mkdirSync(shotsDir, { recursive: true });

  const file = path.isAbsolute(out || '') ? out : path.join(shotsDir, out || `page-${Date.now()}.png`);

  await page.cdp.send('Target.activateTarget', { targetId: page.targetId });
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: Boolean(full) });

  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

// The same typing-that-a-framework-hears as `fill` below, for any page.
const fillExpression = (selector, value) => `(() => {
  const element = ${elementFor(selector)};
  if (!element) return false;
  const prototype = element instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
  setter.call(element, ${JSON.stringify(value ?? '')});
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

// A click, as a pointer actually delivers it.
//
// `element.click()` alone dispatches one click event and nothing else, which a
// plain button hears and a component library often does not: anything driven by
// pointerdown — tabs, menus, dialogs — sits there looking clicked and does not
// move. Sending the whole sequence is what makes those behave, and it is
// harmless to an ordinary button, which just sees its click at the end.
const clickExpression = (selector) => `(() => {
  const element = ${elementFor(selector)};
  if (!element) return false;
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const Event = type.startsWith('pointer') && window.PointerEvent ? window.PointerEvent : window.MouseEvent;
    element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  }
  return true;
})()`;

//
// The approval window, answered from here.
//
// What `approve` presses is whatever the wallet is showing, so it prints that
// screen before pressing anything, and a transcript of a test run is a record
// of what was signed. `--expect <type>` makes a run fail rather than approve
// something it did not ask for.
//
const approveLabels = {
  connect: 'Connect',
  sendTransaction: 'Confirm',
  signMessage: 'Sign',
  signAndSendBlock: 'Sign and send',
};
const rejectLabels = ['Reject', 'Cancel'];

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

// The one thing between this harness and signing for real. The wallet it
// unlocks is whatever wallet.json says, and that file is meant to be edited, so
// the devnet is not taken for granted: the node has to be on this machine and
// the chain must not be mainnet's, or nothing is pressed.
const devnetRefusal = (config) => {
  let host;

  try {
    host = new URL(config.nodeUrl).hostname;
  } catch (err) {
    return `the wallet's node URL ${JSON.stringify(config.nodeUrl)} does not parse`;
  }
  if (!loopbackHosts.has(host)) {
    return `the wallet's node is ${host}, not this machine`;
  }
  if (!Number.isInteger(config.chainId) || config.chainId === 1) {
    return `the wallet signs for chain ${config.chainId}, which is mainnet's or none`;
  }
  return null;
}

// The worker only answers its control surface to extension pages, and the
// harness popup is one.
const askWorker = (popup, method, params = {}) => popup.evaluate(`new Promise((resolve) =>
  chrome.runtime.sendMessage(${JSON.stringify({ channel: 'internal', method, params })}, (reply) => resolve(reply || {})))`);

// Oldest first, because the oldest is what the window draws.
const pendingApprovals = async (popup) => {
  const reply = await askWorker(popup, 'approvals.list');

  if (reply.error) {
    throw new Error(`The wallet would not list its approvals: ${reply.error}`);
  }
  const queue = Array.isArray(reply.result) ? reply.result : Object.values(reply.result || {});

  return queue.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

const describeRequest = (request) => {
  const params = request.params || {};

  switch (request.type) {
    case 'signMessage':
      return JSON.stringify(String(params.message || '').slice(0, 80));
    case 'signAndSendBlock':
      return `to ${params.toAddress} amount ${params.amount} ${params.tokenStandard} chain ${params.chainIdentifier}, ${String(params.data || '').length} chars of data`;
    case 'sendTransaction':
      return `to ${params.to} amount ${params.amount} ${params.tokenStandard}`;
    default:
      return '';
  }
}

const findApprovalWindow = async (cdp, extensionOrigin, timeout) => {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const found = targetInfos.find((target) =>
      target.type === 'page' && target.url.startsWith(extensionOrigin) && target.url.includes(approvalHash));

    if (found) {
      return found;
    }
    await sleep(250);
  }
  return null;
}

const answerApproval = async (flags, { approve }) => {
  const timeout = Number(flags.timeout || 60) * 1000;
  const { cdp, popup, extensionId } = await attach();
  const extensionOrigin = `chrome-extension://${extensionId}/`;

  if (approve) {
    const refusal = devnetRefusal(loadWalletConfig());

    if (refusal) {
      throw new Error(`Not approving anything: ${refusal}. Point .dev-harness/wallet.json at a local devnet.`);
    }
  }

  const target = await findApprovalWindow(cdp, extensionOrigin, timeout);

  if (!target) {
    throw new Error(`No approval window opened within ${timeout / 1000}s.`);
  }

  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const approval = new Popup(cdp, sessionId, target.url, extensionOrigin);

  await approval.send('Runtime.enable');

  if (!(await approval.waitFor("!!document.querySelector('.approval-title')", { timeout }))) {
    const screen = await approval.evaluate("(document.body.innerText || '').trim().slice(0, 300)").catch(() => '');
    throw new Error(`The approval window never showed a request. It shows: ${screen}`);
  }

  const [request] = await pendingApprovals(popup);

  if (!request) {
    throw new Error('The approval window is open, but the wallet has nothing queued.');
  }
  if (typeof flags.expect === 'string' && flags.expect !== request.type) {
    throw new Error(`Expected a ${flags.expect} request, but the wallet is showing ${request.type} from ${request.origin}. Nothing was pressed.`);
  }
  // A block names its own chain. The wallet signs for the one it is set to, but
  // a page asking for mainnet's is a page this harness was not meant for.
  if (approve && request.type === 'signAndSendBlock' && Number(request.params?.chainIdentifier) === 1) {
    throw new Error(`The block asks for chain 1. Nothing was pressed.`);
  }

  const screen = await approval.evaluate("((document.querySelector('.approval-screen') || document.body).innerText || '').trim()");

  console.log(`${request.type} from ${request.origin} (request ${request.id})`);
  console.log(screen.split('\n').map((line) => `  | ${line}`).join('\n'));

  const labels = approve ? [approveLabels[request.type]] : rejectLabels;

  if (!labels[0]) {
    throw new Error(`The harness does not know how to approve a ${request.type} request.`);
  }

  const pressed = await approval.waitFor(`(() => {
    const wanted = ${JSON.stringify(labels)};
    const button = Array.from(document.querySelectorAll('.approval-screen button'))
      .find((element) => wanted.includes(element.textContent.trim()));
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`, { timeout: 5000 });

  if (!pressed) {
    const warning = await approval.evaluate("(document.querySelector('.approval-warning') || {}).innerText || ''").catch(() => '');
    throw new Error(`Could not press ${labels.join(' or ')}${warning ? `: ${warning}` : ' - the button is missing or disabled'}.`);
  }
  console.log(`Pressed ${approve ? labels[0] : 'reject'}.`);

  // A block can spend a while on plasma before it is sent, so the request is
  // done when the wallet lets go of it, not when the button was pressed. What
  // happened is read off the toasts on the way: a send that fails is answered to
  // the page as a rejection, and the queue emptying looks the same either way.
  const settleDeadline = Date.now() + Number(flags.timeout || 180) * 1000;
  const toasts = new Map();
  const noteToasts = async () => {
    const shown = await approval.evaluate(`Array.from(document.querySelectorAll('.Toastify__toast')).map((toast) =>
      ({ error: toast.className.includes('--error'), text: toast.innerText.trim() }))`).catch(() => []);

    shown.filter((toast) => toast.text).forEach((toast) => toasts.set(toast.text, toast));
  };

  while ((await pendingApprovals(popup)).some((queued) => queued.id === request.id)) {
    await noteToasts();

    if (Date.now() > settleDeadline) {
      const label = await approval.evaluate(`(Array.from(document.querySelectorAll('.approval-screen button')).pop() || {}).textContent`).catch(() => '');
      throw new Error(`Still waiting on request ${request.id} after pressing (the button reads ${JSON.stringify(label)}).`);
    }
    await sleep(500);
  }
  await noteToasts();

  toasts.forEach((toast) => console.log(`Wallet ${toast.error ? 'error' : 'says'}: ${toast.text}`));

  const failed = [...toasts.values()].find((toast) => toast.error);

  if (failed) {
    throw new Error(`The wallet reported a failure for request ${request.id}: ${failed.text}`);
  }
  console.log(`The wallet has answered request ${request.id}.`);
}

const commands = {
  async build() {
    await runBuild();
  },

  async open(flags, positional) {
    const url = positional[0];

    if (!url) {
      throw new Error('Open what? Pass a URL.');
    }

    const { cdp } = await attach();
    const { targetId } = await cdp.send('Target.createTarget', { url });

    writeJson(stateFile, { ...readJson(stateFile, {}), pageTargetId: targetId });

    const page = await attachToPage(cdp, { targetId, url });

    // A new tab starts on about:blank, which is already complete, so waiting on
    // readyState alone asked about the provider before the page was even there.
    await page.waitFor("location.href !== 'about:blank' && document.readyState === 'complete'", { timeout: 30000 });

    const provider = await page.evaluate(`(() => window.zenon ? {
      version: window.zenon.version,
      methods: Object.keys(window.zenon).filter((key) => typeof window.zenon[key] === 'function'),
    } : null)()`);

    console.log(`Opened ${url}`);
    console.log(provider
      ? `Provider injected (version ${provider.version}): ${provider.methods.join(', ')}`
      : 'No provider on this page. Is it http(s), and did the extension load?');
  },

  // page goto <url> | eval <expression> | text [selector] | click <selector>
  //      | fill <selector> <value> | shot [--out name.png] [--full]
  async page(flags, positional) {
    const [action, ...rest] = positional;
    const { cdp } = await attach();
    const page = await attachToPage(cdp, await findPageTarget(cdp, flags));

    switch (action) {
      case 'goto': {
        await page.send('Page.navigate', { url: rest[0] });
        await sleep(500);
        await page.waitFor("document.readyState === 'complete'", { timeout: 30000 });
        console.log(`Now on ${await page.evaluate('location.href')}`);
        return;
      }
      // Worth having beside `goto`, because on a single-page app `goto` often
      // is not one: an address that differs only in its hash moves the router
      // and leaves everything the page had in memory exactly where it was.
      // Anything the page read once at startup — a wallet's own account, an
      // identity, a list fetched on mount — then stays on screen after it has
      // changed underneath, which reads as the change not having happened.
      case 'reload': {
        await page.send('Page.reload', { ignoreCache: Boolean(flags.hard) });
        await sleep(500);
        await page.waitFor("document.readyState === 'complete'", { timeout: 30000 });
        console.log(`Reloaded ${await page.evaluate('location.href')}`);
        return;
      }
      case 'eval': {
        const value = await page.evaluate(rest.join(' '));
        console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
        return;
      }
      case 'text': {
        console.log(await page.evaluate(`(${elementFor(rest[0] || 'body')} || {}).innerText || '(no match)'`));
        return;
      }
      case 'click': {
        if (!(await page.evaluate(clickExpression(rest[0])))) {
          throw new Error(`Nothing matches ${rest[0]}`);
        }
        await sleep(400);
        console.log(`Clicked ${rest[0]}`);
        break;
      }
      case 'fill': {
        if (!(await page.evaluate(fillExpression(rest[0], rest[1])))) {
          throw new Error(`Nothing matches ${rest[0]}`);
        }
        await sleep(300);
        console.log(`Filled ${rest[0]}`);
        break;
      }
      case 'shot':
        break;
      default:
        throw new Error('page what? goto, eval, text, click, fill or shot.');
    }

    if (action === 'shot' || flags.shot) {
      console.log(`Screenshot: ${await pageScreenshot(page, { out: flags.out, full: flags.full })}`);
    }
  },

  async approvals() {
    const { popup } = await attach();
    const queue = await pendingApprovals(popup);

    if (!queue.length) {
      console.log('Nothing is waiting for approval.');
      return;
    }
    queue.forEach((request) =>
      console.log(`${request.id}  ${request.type}  from ${request.origin}  ${describeRequest(request)}`));
  },

  async approve(flags) {
    await answerApproval(flags, { approve: true });
  },

  async reject(flags) {
    await answerApproval(flags, { approve: false });
  },

  async start(flags) {
    if (!flags['no-build']) {
      await runBuild();
    }

    const overrides = {};
    if (typeof flags.node === 'string') overrides.nodeUrl = flags.node;
    if (typeof flags.chain === 'string') overrides.chainId = Number(flags.chain);
    // Which account inside the wallet, and which wallet at all. A second
    // instance is only a second party if it signs as somebody else.
    if (typeof flags['address-index'] === 'string') overrides.addressIndex = Number(flags['address-index']);
    if (typeof flags.mnemonic === 'string') overrides.mnemonic = flags.mnemonic;
    if (typeof flags['wallet-name'] === 'string') overrides.walletName = flags['wallet-name'];

    const { popup, extensionId } = await attach({ navigate: true, walletOverrides: overrides });

    console.log(`Extension ${extensionId} loaded, popup at ${popup.url}`);

    if (!(await waitForUnlock(popup))) {
      process.exitCode = 1;
      return;
    }
    console.log('Wallet unlocked.');

    if (typeof flags.route === 'string') {
      await routeTo(popup, flags.route);
      console.log(`Now on ${flags.route}`);
    }
    console.log(`Screenshot: ${await screenshot(popup, { out: flags.out, full: flags.full })}`);
  },

  async route(flags, positional) {
    const { popup } = await attach();
    await routeTo(popup, positional[0] || flags.route);
    console.log(`Screenshot: ${await screenshot(popup, { out: flags.out, full: flags.full })}`);
  },

  async shot(flags, positional) {
    const { popup } = await attach();

    if (positional[0] || flags.route) {
      await routeTo(popup, positional[0] || flags.route);
    }
    console.log(`Screenshot: ${await screenshot(popup, { out: flags.out, full: flags.full })}`);
  },

  async text(flags, positional) {
    const { popup } = await attach();
    const selector = positional[0] || 'body';

    console.log(await popup.evaluate(
      `(${elementFor(selector)} || {}).innerText || '(no match)'`));
  },

  async click(flags, positional) {
    const { popup } = await attach();
    const selector = positional[0];

    const clicked = await popup.evaluate(clickExpression(selector));

    if (!clicked) {
      throw new Error(`Nothing matches ${selector}`);
    }
    await sleep(400);
    console.log(`Screenshot: ${await screenshot(popup, { out: flags.out, full: flags.full })}`);
  },

  // React keeps its own copy of an input's value, so setting `value` and
  // leaving it there is a change React never hears about. Going through the
  // prototype setter and firing the event it listens for is what makes the
  // typing real.
  //
  // Which prototype's setter, though, is decided by the element: calling
  // `HTMLInputElement`'s on a <textarea> throws "Illegal invocation", which is
  // what this did to the sign-message screen, the first textarea in the wallet.
  async fill(flags, positional) {
    const { popup } = await attach();
    const [selector, value] = positional;

    const filled = await popup.evaluate(fillExpression(selector, value));

    if (!filled) {
      throw new Error(`Nothing matches ${selector}`);
    }
    await sleep(300);
    console.log(`Screenshot: ${await screenshot(popup, { out: flags.out, full: flags.full })}`);
  },

  async eval(flags, positional) {
    const { popup } = await attach();
    const value = await popup.evaluate(positional.join(' '));

    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  },

  async logs(flags) {
    const { popup } = await attach();
    const entries = await popup.evaluate('(window.__syriusHarness && window.__syriusHarness.entries) || []');

    if (!entries.length) {
      console.log('(nothing logged since this page loaded)');
    }
    entries.forEach((entry) => console.log(`${entry.at} [${entry.level}] ${entry.text}`));

    if (flags.clear) {
      await popup.evaluate('window.__syriusHarness.entries.length = 0');
    }
  },

  async reload(flags) {
    if (!flags['no-build']) {
      await runBuild();
    }

    // The extension itself has to be reloaded, not just the page. The manifest,
    // the service worker and the content scripts are read by the browser when
    // the extension loads, so navigating the popup alone leaves the worker
    // running the previous build.
    //
    // Reloading it also orphans whatever popup page is already open: that page
    // keeps a `chrome.runtime` bound to an extension generation that no longer
    // exists, and every message it sends goes unanswered. So the page is
    // navigated afterwards, which is what binds it to the new one.
    const { popup } = await attach({ reloadExtension: true, navigate: true });

    if (!(await waitForUnlock(popup))) {
      process.exitCode = 1;
      return;
    }

    if (typeof flags.route === 'string') {
      await routeTo(popup, flags.route);
    }
    console.log(`Screenshot: ${await screenshot(popup, { out: flags.out, full: flags.full })}`);
  },

  async status() {
    const version = await isChromeUp();

    if (!version) {
      console.log('Harness Chrome is not running.');
      return;
    }
    const state = readJson(stateFile, {});
    const wallet = readJson(walletFile, {});

    console.log(`${version.Browser} on port ${debugPort}`);
    console.log(`Extension: ${state.extensionId || '(not seen yet)'}`);
    console.log(`Wallet:    ${wallet.walletName} on ${wallet.nodeUrl}`);
  },

  async stop() {
    const version = await isChromeUp();

    if (!version) {
      console.log('Harness Chrome is not running.');
      return;
    }

    const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();

    await sleep(500);

    if (await isChromeUp()) {
      const { pid } = readJson(stateFile, {});
      if (pid) {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      }
    }
    console.log('Stopped.');
  },
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);

  if (!command || !commands[command]) {
    console.log(fs.readFileSync(__filename, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('//'))
      .map((line) => line.slice(3))
      .join('\n'));
    process.exitCode = command ? 1 : 0;
    return;
  }

  try {
    await commands[command](flags, positional);
  } catch (err) {
    console.error(`${command} failed: ${err.message}`);
    process.exitCode = 1;
  }
  // Every command holds an open websocket, and nothing else is keeping this
  // process alive once the work is done.
  process.exit(process.exitCode || 0);
}

main();
