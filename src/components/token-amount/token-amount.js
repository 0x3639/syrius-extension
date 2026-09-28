import React from 'react';
import { authorizationMetadata, normalizeBaseUnits } from '../../services/wallet/tokenMetadata';
import { formatExact } from '../../services/utils/format';

// The confirmation's amount presentation never uses metadata from the node.
const TokenAmount = ({ amount, tokenStandard }) => {
  let metadata;
  let units;
  try {
    metadata = authorizationMetadata(tokenStandard);
    units = normalizeBaseUnits(amount);
  } catch (err) {
    return (
      <>
        <dt>Amount</dt>
        <dd className="approval-warning">Invalid amount or token identifier</dd>
        <dt>Token</dt>
        <dd className="approval-warning">Invalid token identifier</dd>
      </>
    );
  }
  return (
    <>
      <dt>Amount</dt>
      <dd className="word-break-all">
        {metadata.isNative
          ? `${formatExact(units, metadata.decimals)} ${metadata.symbol}`
          : `${units} base units`}
      </dd>
      <dt>Token</dt>
      <dd className="word-break-all">{metadata.tokenStandard}</dd>
      {metadata.isNative ? (
        <>
          <dt>Base units</dt>
          <dd className="word-break-all">{units}</dd>
        </>
      ) : (
        <>
          <dt>Token details</dt>
          <dd>Unverified. Confirm the token identifier and the exact base-unit amount.</dd>
        </>
      )}
    </>
  );
};

export default TokenAmount;
