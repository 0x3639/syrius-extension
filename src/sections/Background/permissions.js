// Permission readers and writers share a lock so they cannot observe a
// partially finalized approval or overwrite a later withdrawal.
const storageKey = 'syrius.permissions';
const pendingKey = 'syrius.permissionApprovals';
const serialized = operation => navigator.locks.request(storageKey, operation);
const own = (all, key) => Object.hasOwn(all, key) ? all[key] : null;
const readAll = async () => (await chrome.storage.local.get(storageKey))[storageKey] || {};
const readPending = async () => (await chrome.storage.session.get(pendingKey))[pendingKey] || {};
const writeAll = all => chrome.storage.local.set({ [storageKey]: all });
const writePending = all => chrome.storage.session.set({ [pendingKey]: all });
// Retain prior consent if a new approval fails; never turn its attempted grant
// into authority. The persisted guard also covers a worker restart mid-write.
const interrupted = new Map();
const active = (all, pending, origin) => {
  if (interrupted.has(origin)) return interrupted.get(origin);
  const entry = own(all, origin), guard = own(pending, origin);
  return guard && entry?.approvalAttempt === guard.id ? guard.previous : entry;
};
const checkDeadline = expiresAt => {
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) throw new Error('Approval expired during finalization.');
};

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

const isConnected = async origin => {
  try { return await serialized(async () => Boolean(origin && active(await readAll(), await readPending(), origin))); }
  catch (error) { return false; }
};
const get = origin => serialized(async () => active(await readAll(), await readPending(), origin));
const list = () => serialized(async () => {
  const all = await readAll(), pending = await readPending();
  return Object.keys(all).map(origin => active(all, pending, origin)).filter(Boolean)
    .sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));
});

const grant = (origin, { title = '', favicon = '' } = {}, { expiresAt, complete } = {}) => serialized(async () => {
  if (!origin || typeof complete !== 'function') return false;
  checkDeadline(expiresAt);
  const all = await readAll(), pending = await readPending();
  checkDeadline(expiresAt);
  const previous = active(all, pending, origin), id = crypto.randomUUID();
  const guarded = { ...pending, [origin]: { id, previous } };
  const completed = { ...pending }; delete completed[origin];
  const restored = { ...all }; if (previous) restored[origin] = previous; else delete restored[origin];
  try {
    await writePending(guarded); checkDeadline(expiresAt);
    await writeAll({ ...all, [origin]: { origin, title, favicon, approvalAttempt: id,
      connectedAt: previous?.connectedAt || Date.now(), lastUsedAt: Date.now() } });
    checkDeadline(expiresAt);
    await writePending(completed); checkDeadline(expiresAt);
    // complete dispatches the response synchronously after the final check.
    // There is no further awaited attention/storage operation before dispatch.
    complete(); interrupted.delete(origin); return true;
  } catch (error) {
    interrupted.set(origin, previous);
    // Either saved fallback or restored local state is enough to withhold the
    // new grant across restart. If both stores fail, this worker still denies
    // it and reports the failure; durable cleanup has not completed.
    await writePending(guarded).catch(() => {});
    try { await writeAll(restored); interrupted.delete(origin); await writePending(completed).catch(() => {}); }
    catch (cleanupError) { /* Keep the persisted guard and in-memory fallback. */ }
    throw error;
  }
});
const revoke = origin => serialized(async () => {
  const all = await readAll(); delete all[origin]; await writeAll(all);
  interrupted.delete(origin); return true;
});
const revokeAll = () => serialized(async () => { await writeAll({}); interrupted.clear(); return true; });
const touch = origin => serialized(async () => {
  const all = await readAll(), entry = active(all, await readPending(), origin);
  if (!entry) return false;
  all[origin] = { ...entry, lastUsedAt: Date.now() }; await writeAll(all); return true;
});
const permissions = { storageKey, originOf, isConnected, get, list, grant, revoke, revokeAll, touch };
export default permissions;
