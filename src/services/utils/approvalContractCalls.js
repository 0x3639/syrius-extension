/* global BigInt */
import { Primitives } from 'znn-ts-sdk';
import abi from './contractCallSchemas.json';
import { selectorOf, contractDisplayName, describeCall } from './contractCalls';

// This approval decoder is intentionally separate from the selector-only
// transaction-history API. Known means every argument was decoded exactly.
// Schemas/addresses: go-zenon at the revision retained in contractCallSchemas.
const contracts = Object.fromEntries(Object.entries(abi.contracts).map(([name, contract]) => [contract.address, {
  name,
  methods: Object.fromEntries(contract.methods.map(method => [
    selectorOf(`${method.name}(${method.inputs.map(input => input.type).join(',')})`), method,
  ])),
}]));
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const uint = bytes => BigInt('0x' + hex(bytes));
const invalid = () => { throw new Error('Unsupported or noncanonical contract arguments'); };
const labels = {
  address: 'Plasma beneficiary', id: 'Request ID', name: 'Name', description: 'Description', url: 'URL',
  producerAddress: 'Producer address', rewardAddress: 'Reward address',
  giveBlockRewardPercentage: 'Block reward share (%)', giveDelegateRewardPercentage: 'Delegate reward share (%)',
  publicKey: 'Public key', signature: 'Signature', durationInSec: 'Duration (seconds)',
  tokenName: 'Token name', tokenSymbol: 'Token symbol', tokenDomain: 'Token domain',
  totalSupply: 'Total supply (base units)', maxSupply: 'Maximum supply (base units)', decimals: 'Token decimals',
  isMintable: 'Minting enabled', isBurnable: 'Burning enabled', isUtility: 'Utility token',
  tokenStandard: 'Token ID', amount: 'Amount (base units)', receiveAddress: 'Recipient', owner: 'New token owner',
  hashLocked: 'Hash-lock beneficiary', expirationTime: 'Expiry (Unix seconds)', hashType: 'Hash algorithm code',
  keyMaxSize: 'Maximum key size (bytes)', hashLock: 'Hash lock', preimage: 'Unlock preimage',
  znnReward: 'ZNN rewards (base units)', qsrReward: 'QSR rewards (base units)', burnAmount: 'ZNN to burn (base units)',
  znnFundsNeeded: 'ZNN requested (base units)', qsrFundsNeeded: 'QSR requested (base units)', vote: 'Vote code',
  networkClass: 'Network class', chainId: 'Chain ID', toAddress: 'Recipient', transactionHash: 'Transaction hash',
  logIndex: 'Log index', tokenAddress: 'Remote token address',
};
// Quotes preserve empty strings and whitespace. Formatting controls are escaped
// visibly, including a leading BOM, rather than changing the apparent value.
const displayString = text => JSON.stringify(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
  char => Array.from({ length: char.length }, (_, index) => '\\u' + char.charCodeAt(index).toString(16).padStart(4, '0')).join(''));
const decodeArguments = (bytes, inputs) => {
  if (bytes.length < inputs.length * 32 || bytes.length % 32) return invalid();
  let end = inputs.length * 32;
  const args = inputs.map(({ name, type }, index) => {
    const word = bytes.slice(index * 32, (index + 1) * 32);
    let value;
    if (type === 'string' || type === 'bytes') {
      const offset = uint(word);
      if (offset !== BigInt(end) || end + 32 > bytes.length) return invalid();
      const length = uint(bytes.slice(end, end + 32));
      if (length > BigInt(bytes.length - end - 32)) return invalid();
      const size = Number(length), start = end + 32;
      end = start + Math.ceil(size / 32) * 32;
      if (end > bytes.length || bytes.slice(start + size, end).some(byte => byte !== 0)) return invalid();
      const content = bytes.slice(start, start + size);
      value = type === 'bytes' ? '0x' + hex(content) : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    } else if (/^uint(?:8|32|64|256)$/.test(type)) {
      const number = uint(word), bits = BigInt(type.slice(4));
      if (number >= 1n << bits) return invalid();
      value = number.toString();
    } else if (type === 'int64') {
      const number = uint(word), signed = number & (1n << 255n) ? number - (1n << 256n) : number;
      if (signed < -(1n << 63n) || signed >= 1n << 63n) return invalid();
      value = signed.toString();
    } else if (type === 'bool') {
      const number = uint(word); if (number > 1n) return invalid();
      value = number === 1n ? 'true' : 'false';
    } else if (type === 'hash') {
      value = hex(word);
    } else if (type === 'address' || type === 'tokenStandard') {
      const size = type === 'address' ? 20 : 10;
      if (word.slice(0, 32 - size).some(byte => byte !== 0)) return invalid();
      const core = word.slice(32 - size);
      value = type === 'address' ? new Primitives.Address('z', core).toString() : new Primitives.TokenStandard(core).toString();
    } else return invalid();
    return Object.freeze({ name, type, value, label: labels[name] || name,
      display: type === 'string' ? displayString(value) : value });
  });
  if (end !== bytes.length) return invalid();
  return Object.freeze(args);
};

const decodeApprovalCall = json => {
  let contract;
  try {
    const address = Primitives.Address.parse(json.toAddress);
    const destination = address.toString();
    contract = contracts[destination];
    const unknown = { kind: 'unknownCall', contract: contract ? contractDisplayName(contract.name) : 'unrecognized', to: destination };
    if (json.blockType !== 2) return unknown;
    const binary = atob(json.data || '');
    if (btoa(binary) !== (json.data || '')) return unknown;
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    if (!contract) return address.getBytes()[0] === 0 && bytes.length === 0 ? { kind: 'transfer', to: destination } : unknown;
    if (bytes.length < 4) return unknown;
    const method = contract.methods[hex(bytes.slice(0, 4))];
    if (!method) return unknown;
    const args = decodeArguments(bytes.slice(4), method.inputs);
    return Object.freeze({ kind: 'knownCall', contract: contractDisplayName(contract.name), to: destination,
      method: method.name, label: describeCall(contract.name, method.name), args });
  } catch (error) {
    return { kind: 'unknownCall', contract: contract ? contractDisplayName(contract.name) : 'unrecognized', to: json?.toAddress };
  }
};
export { decodeApprovalCall, displayString };
