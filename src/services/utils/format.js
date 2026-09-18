import { ethers } from 'ethers';

// Amounts on this ledger are integers of the token's smallest unit, and they do
// not fit in a double: a whole ZNN is 1e8 units and total supply is far past
// 2^53. Every screen in this wallet used to divide by `Math.pow(10, decimals)`
// or rebuild the same nested `formatUnits(BigNumber.from(...), BigNumber.from(...))`
// expression inline, which is how `4.35 ZNN` came to be sent as 434999999 units
// instead of 435000000. All of it goes through here now.

const defaultDecimals = 8;

// `decimals` reaches these helpers from RPC responses and from stored token
// metadata, so it arrives as a number, a string, or missing entirely.
const toDecimals = (decimals) => {
  const parsed = Number(decimals);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 30 ? parsed : defaultDecimals;
};

// The SDK hands back BigNumber for balances, but a JSON block that has been
// through `toJson()` carries a decimal string, and the fallback token map holds
// a plain 0. Anything non-numeric is a zero rather than a thrown render.
const toBigNumber = (value) => {
  try {
    if (value === null || value === undefined || value === '') {
      return ethers.constants.Zero;
    }
    if (ethers.BigNumber.isBigNumber(value)) {
      return value;
    }
    return ethers.BigNumber.from(value.toString());
  } catch (err) {
    return ethers.constants.Zero;
  }
};

// The exact value, all decimal places, no grouping. This is what a confirmation
// screen and a clipboard need — never a rounded one.
const formatExact = (value, decimals) =>
  ethers.utils.formatUnits(toBigNumber(value), toDecimals(decimals));

// Trailing zeros are noise on a balance line: 12.50000000 reads as 12.5.
const trimZeros = (text) => {
  if (!text.includes('.')) {
    return text;
  }
  return text.replace(/0+$/, '').replace(/\.$/, '');
};

const groupThousands = (text) => {
  const [whole, fraction] = text.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
};

// The balance as a person reads it: grouped, and cut to a few decimals so a
// number stays on one line in a 360px popup. Pair it with `formatExact` in a
// tooltip wherever the difference could matter.
const formatAmount = (value, decimals, { maxDecimals = 4, group = true } = {}) => {
  const exact = formatExact(value, decimals);
  const [whole, fraction = ''] = exact.split('.');
  const shown = fraction.slice(0, maxDecimals);
  const text = trimZeros(shown ? `${whole}.${shown}` : whole);
  return group ? groupThousands(text) : text;
};

// True when `formatAmount` had to drop something, so a caller knows whether the
// exact value is worth offering.
const isRounded = (value, decimals, maxDecimals = 4) => {
  const fraction = formatExact(value, decimals).split('.')[1] || '';
  return trimZeros(fraction).length > maxDecimals;
};

// Turns what somebody typed into base units. Returns null rather than throwing
// or silently truncating, because every caller is a form that has to say why it
// refused. `parseUnits` rejects more decimals than the token has, which is the
// behaviour we want — 0.123456789 ZNN is not a rounding question, it is a typo.
const parseAmount = (input, decimals) => {
  const text = (input === null || input === undefined ? '' : input.toString()).trim();

  if (!text || !/^\d*\.?\d*$/.test(text) || text === '.') {
    return null;
  }
  try {
    return ethers.utils.parseUnits(text, toDecimals(decimals));
  } catch (err) {
    return null;
  }
};

// A dollar amount, grouped like `formatAmount`. Small holdings are worth a
// couple more decimal places — $0.03 and $0.0003 read very differently — but
// past a dollar the extra precision is noise nobody asked for.
const formatUsd = (amount) => {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return null;
  }
  const decimals = Math.abs(amount) < 1 ? 4 : 2;
  return `$${groupThousands(amount.toFixed(decimals))}`;
};

// Addresses are 40 characters and the popup is 360px wide.
const truncateAddress = (address, lead = 6, tail = 4) => {
  const text = (address || '').toString();
  return text.length <= lead + tail + 1 ? text : `${text.slice(0, lead)}…${text.slice(-tail)}`;
};

const truncateHash = (hash) => truncateAddress(hash, 8, 6);

// Momentums are produced every ten seconds, so a height difference is a
// duration. Used for plasma fuse expiry and stake maturity.
const momentumsToDuration = (momentums) => {
  const seconds = Math.max(0, Number(momentums) || 0) * 10;

  if (seconds < 60) {
    return 'under a minute';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours} h`;
  }
  return `${Math.round(hours / 24)} days`;
};

export {
  defaultDecimals,
  formatAmount,
  formatExact,
  formatUsd,
  isRounded,
  parseAmount,
  toBigNumber,
  toDecimals,
  truncateAddress,
  truncateHash,
  momentumsToDuration,
};
