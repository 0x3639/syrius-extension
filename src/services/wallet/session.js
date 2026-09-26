import { getSettings } from '../utils/storage';
import lease from './sessionLease';

// The owner token never leaves this document except in its trusted session
// marker. Other documents receive fresh tokens and cannot resume On close.
const ownerId = crypto.randomUUID();
const options = (values = {}) => ({ ...values, ownerId, minutes: getSettings().autoLockMinutes });
const load = async () => {
  try { return await lease.load(); }
  catch (error) { return null; }
};
const create = (expectedId, values, adopt) => lease.create(expectedId, options(values), adopt);
const restore = (record, selectedAddressIndex, adopt) => lease.renew(record.id, options({
  walletName: record.walletName, selectedAddressIndex, resumable: true,
}), (current, entropy) => adopt(current, entropy));
const use = (id, operation) => lease.use(id, ownerId, operation);
const touch = (id, values, operation) => lease.renew(id, options(values), operation);
const publish = (id, publicState) => lease.publish(id, ownerId, publicState);
const session = {
  sessionKey: lease.sessionKey, publicStateKey: lease.publicStateKey,
  ended: lease.ended, begin: lease.begin, create, restore, use, touch, load,
  clear: lease.clear, publish, isLockedGeneration: lease.isLockedGeneration,
};
export default session;
