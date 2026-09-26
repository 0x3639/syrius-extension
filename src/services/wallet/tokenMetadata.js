import { Primitives } from 'znn-ts-sdk';
import { ethers } from 'ethers';
import fallbackValues from '../utils/fallbackValues';
import { parseAmount, toBigNumber } from '../utils/format';

const znnZts = 'zts1znnxxxxxxxxxxxxx9z4ulx';
const qsrZts = 'zts1qsrxxxxxxxxxxxxxmrhjll';

const nativeTokens = Object.freeze(
  Object.fromEntries(
    Object.entries(fallbackValues.availableTokens).map(([zts, entry]) => [
      zts,
      Object.freeze({ ...entry.token }),
    ])
  )
);

const normalizeTokenStandard = (value) =>
  Primitives.TokenStandard.parse(value?.toString()).toString();

// Use the SDK's integer parser for both approval text and construction. In
// particular, hexadecimal amounts are valid base units, not display errors.
const normalizeBaseUnits = (value) => {
  const amount = ethers.BigNumber.from(value);
  if (amount.lt(0)) {
    throw new Error('The amount must be a nonnegative integer of base units');
  }
  return amount.toString();
};

// A node response cannot authenticate a custom token's decimal scale. Such
// tokens remain sendable in exact integer base units, with their full identity.
const authorizationMetadata = (tokenStandard) => {
  const zts = normalizeTokenStandard(tokenStandard);
  const native = nativeTokens[zts];
  return Object.freeze({
    tokenStandard: zts,
    decimals: native ? native.decimals : 0,
    symbol: native ? native.symbol : 'base units',
    isNative: Boolean(native),
  });
};

const parseTransferAmount = (input, tokenStandard) => {
  const metadata = authorizationMetadata(tokenStandard);
  const text = typeof input === 'string' ? input.trim() : '';
  if (!metadata.isNative && !/^\d+$/.test(text)) {
    return null;
  }
  return parseAmount(text, metadata.decimals);
};

// Primitive copies bind the confirmation and constructor to the same units
// and identity. RPC metadata is never retained in an authorization snapshot.
const prepareTransfer = ({ tokenStandard, amount, recipient, owner, balance }) => {
  const metadata = authorizationMetadata(tokenStandard);
  const parsed = parseTransferAmount(amount, tokenStandard);
  if (!parsed || parsed.lte(0)) {
    throw new Error(metadata.isNative ? 'Enter a positive token amount' : 'Enter a positive integer number of base units');
  }
  if (parsed.gt(toBigNumber(balance))) {
    throw new Error('Not enough balance for this transfer');
  }
  return Object.freeze({
    ...metadata,
    amount: parsed.toString(),
    recipient: Primitives.Address.parse(recipient.trim()).toString(),
    owner,
  });
};

export { normalizeBaseUnits, znnZts, qsrZts, nativeTokens, normalizeTokenStandard, authorizationMetadata, parseTransferAmount, prepareTransfer };
