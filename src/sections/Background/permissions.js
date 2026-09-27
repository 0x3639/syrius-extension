// Which sites this wallet has been connected to.
//
// The old bridge had no concept of a connected site: every call from a page
// opened a popup asking the same question again, and answering it granted
// nothing that outlived the answer. That is why the content script had to be
// pinned to a single hard-coded domain — there was no other way to bound who
// could ask.
//
// A connection here is read access to the selected address, the chain
// identifier and the public node host, granted per origin and remembered. It is never
// permission to move anything: signing and sending are prompted every time,
// the way they are in every wallet a person is likely to have used.

const storageKey = 'syrius.permissions';

const readAll = async () => {
  try {
    const stored = await chrome.storage.local.get(storageKey);
    return stored[storageKey] || {};
  } catch (err) {
    return {};
  }
};

const writeAll = async (permissions) => {
  try {
    await chrome.storage.local.set({ [storageKey]: permissions });
    return true;
  } catch (err) {
    return false;
  }
};

// A page can claim to be any origin it likes in a postMessage, so the origin
// used for a permission decision is always the one Chrome reports for the
// sender, never one the page supplied.
const originOf = (sender) => {
  if (sender && sender.origin) {
    return sender.origin;
  }
  try {
    return sender && sender.url ? new URL(sender.url).origin : null;
  } catch (err) {
    return null;
  }
};

const isConnected = async (origin) => {
  if (!origin) {
    return false;
  }
  const all = await readAll();
  return Boolean(all[origin]);
};

const get = async (origin) => (await readAll())[origin] || null;

const list = async () => {
  const all = await readAll();
  return Object.values(all).sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));
};

const grant = async (origin, { title = '', favicon = '' } = {}) => {
  if (!origin) {
    return false;
  }
  const all = await readAll();
  all[origin] = {
    origin,
    title,
    favicon,
    connectedAt: all[origin]?.connectedAt || Date.now(),
    lastUsedAt: Date.now(),
  };
  return writeAll(all);
};

const revoke = async (origin) => {
  const all = await readAll();
  delete all[origin];
  return writeAll(all);
};

const revokeAll = async () => writeAll({});

const touch = async (origin) => {
  const all = await readAll();
  if (all[origin]) {
    all[origin].lastUsedAt = Date.now();
    await writeAll(all);
  }
};

const permissions = { storageKey, originOf, isConnected, get, list, grant, revoke, revokeAll, touch };

export default permissions;
