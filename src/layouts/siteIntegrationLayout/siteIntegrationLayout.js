import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { Primitives, Zenon, utils as sdkUtils } from 'znn-ts-sdk';

import TokenAmount from '../../components/token-amount/token-amount';
import { authorizationMetadata, normalizeBaseUnits } from '../../services/wallet/tokenMetadata';
import useAccount from '../../services/hooks/useAccount';
import useBlockSender from '../../services/hooks/useBlockSender';
import vault from '../../services/wallet/vault';
import { signMessage } from '../../services/wallet/signMessage';
import { sendInternal } from '../../services/utils/messaging';
import {
  formatExact,
  toBigNumber,
  truncateAddress,
} from '../../services/utils/format';
import { readableError } from '../../services/utils/errors';
import { notify } from '../../services/utils/notify';
import { embeddedContractName } from '../../services/utils/contracts';
import { decodeCall, describeCall, contractDisplayName } from '../../services/utils/contractCalls';

// What a site is asking for, and the choice about it.
//
// The old version was one component holding a three-flow, three-step state
// machine in Redux, with nine nested ternaries in its render and three copies
// of the signing code. It also never showed which site was asking — the whole
// screen said "this website" — so the only way to know what you were approving
// was to remember what you had just clicked. And it indexed
// `balanceInfoMap[tokenStandard]` without a guard, so a request for a token the
// account did not hold threw before the screen drew at all.

const hostOf = (origin) => {
  try {
    return new URL(origin).host;
  } catch (err) {
    return origin || 'Unknown site';
  }
};

// What a raw account block actually does, in words, for the "sign this block?"
// screen — the one place a site can ask for literally anything.
//
// A block sent to an embedded contract is a call, not a transfer: "1 ZNN to
// the HTLC contract" is really "authorize an HTLC swap, funded with 1 ZNN",
// and describing it as a transfer buries the part that matters. A call this
// build cannot decode has to look like a warning rather than like an ordinary
// approval, because "unknown" is exactly the case where reading the raw data
// below is not optional.
const describeBlock = (json) => {
  const contract = embeddedContractName(json?.toAddress);
  const amount = json?.amount;
  const hasAmount = Boolean(amount) && amount !== '0';

  if (!contract) {
    return {
      kind: 'transfer',
      to: json?.toAddress,
      amount,
      hasAmount,
      tokenStandard: json?.tokenStandard,
    };
  }

  const method = decodeCall(contract, json?.data);
  const contractName = contractDisplayName(contract);

  return {
    kind: method ? 'knownCall' : 'unknownCall',
    contract: contractName,
    label: method ? describeCall(contract, method) : null,
    amount,
    hasAmount,
    tokenStandard: json?.tokenStandard,
  };
};

const SiteHeader = ({ request }) => (
  <div className="site-header">
    {request.favicon ? (
      <img
        className="site-favicon"
        alt=""
        src={request.favicon}
        width="28"
        height="28"
      />
    ) : (
      <div className="site-favicon site-favicon-blank" />
    )}
    <div className="site-header-text">
      <div className="site-host">{hostOf(request.origin)}</div>
      {/* Many pages title themselves after their own URL, and printing the host
          twice is noise rather than information. */}
      {request.title && request.title !== hostOf(request.origin) && (
        <div className="site-title">{request.title}</div>
      )}
    </div>
  </div>
);

const SiteIntegrationLayout = () => {
  const navigate = useNavigate();
  const { address, isUnlocked } = useSelector((state) => state.wallet);
  const { chainIdentifier, nodeUrl } = useSelector(
    (state) => state.connectionParameters
  );
  const { balanceMap } = useAccount();
  const { send, isSending, isGeneratingPlasma } = useBlockSender();

  const [request, setRequest] = useState(undefined);
  const [preview, setPreview] = useState(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isWaitingForMore, setIsWaitingForMore] = useState(false);

  // A locked wallet cannot answer anything. The password screen is told where
  // to come back to so the request is not lost.
  useEffect(() => {
    if (!isUnlocked) {
      navigate('/password', {
        replace: true,
        state: { returnTo: '/site-integration' },
      });
    }
  }, [isUnlocked, navigate]);

  // How long to hold the window open on an empty queue before closing it.
  //
  // A site almost never asks for one thing. Connecting is the prelude to
  // whatever it actually wanted — a signature, a block — and it sends that the
  // instant the connect is answered, because being answered is what it was
  // waiting for. Closing on the spot meant the second request always arrived to
  // a window that had already gone: a visible flash as another one opened, and,
  // until the close handler learned which requests were its own, an outright
  // rejection of a prompt nobody had seen.
  //
  // So the window waits a beat and looks again. Long enough to cover the round
  // trip out to the page and back, short enough that a genuinely finished queue
  // does not leave an empty window sitting there.
  const CLOSE_GRACE_MS = 1200;

  const loadNext = useCallback(async () => {
    try {
      const next = await sendInternal('approvals.next');

      if (next) {
        setRequest(next);
        return next;
      }
      setRequest(null);
      setIsWaitingForMore(true);
      await new Promise((resolve) => {
        setTimeout(resolve, CLOSE_GRACE_MS);
      });

      const late = await sendInternal('approvals.next');
      setIsWaitingForMore(false);

      if (late) {
        setRequest(late);
        return late;
      }
      // Nothing left to answer means this window was only ever open for the
      // queue, and the queue is empty.
      window.close();
      return null;
    } catch (err) {
      setIsWaitingForMore(false);
      setRequest(null);
      return null;
    }
  }, []);

  useEffect(() => {
    if (isUnlocked) {
      loadNext();
    }
  }, [isUnlocked, loadNext]);

  // For an arbitrary account block, what will actually be signed — with the
  // fields the SDK fills in (chain, height, previous hash) resolved, rather
  // than the bare JSON the page sent.
  useEffect(() => {
    if (!request || request.type !== 'signAndSendBlock') {
      setPreview(null);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const zenon = Zenon.getSingleton();
        const template = Primitives.AccountBlockTemplate.fromJson(
          request.params
        );
        const keyPair = vault.getKeyPair();
        const filled = await sdkUtils.BlockUtils._checkAndSetFields(
          zenon,
          template,
          keyPair
        );

        if (!cancelled) {
          setPreview(filled.toJson());
        }
      } catch (err) {
        if (!cancelled) {
          // Falling back to what the site sent is better than a blank panel:
          // the point of this screen is that the block is visible before it is
          // signed.
          setPreview(request.params);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [request]);

  const finish = async (id, result, grantOrigin = false) => {
    await sendInternal('approvals.resolve', { id, result, grantOrigin });
    await loadNext();
  };

  const reject = async () => {
    if (!request) {
      return;
    }
    await sendInternal('approvals.reject', { id: request.id });
    await loadNext();
  };

  //
  // Connect
  //
  const approveConnect = async () => {
    setIsBusy(true);
    try {
      await finish(request.id, [address], true);
    } finally {
      setIsBusy(false);
    }
  };

  //
  // Send a plain transfer
  //
  const tokenFor = (tokenStandard) => balanceMap[tokenStandard];

  const approveSendTransaction = async () => {
    setIsBusy(true);

    try {
      const { to, tokenStandard, amount } = request.params;
      authorizationMetadata(tokenStandard);
      const units = normalizeBaseUnits(amount);
      const template = Primitives.AccountBlockTemplate.send(
        Primitives.Address.parse(to),
        Primitives.TokenStandard.parse(tokenStandard),
        toBigNumber(units)
      );
      const signed = await send(template);

      await finish(request.id, {
        hash: signed.hash?.toString(),
        block: signed.toJson?.() ?? null,
      });
      notify.success('Transaction sent');
    } catch (err) {
      notify.error(err);
      await sendInternal('approvals.reject', {
        id: request.id,
        error: { code: -32603, message: readableError(err) },
      });
      await loadNext();
    } finally {
      setIsBusy(false);
    }
  };

  //
  // Sign a message
  //
  // The only approval here that does not touch the network: no plasma, no
  // block, nothing to broadcast. It is over as fast as an Ed25519 signature,
  // and the site gets the answer the moment the button is pressed.
  //
  const approveSignMessage = async () => {
    setIsBusy(true);

    try {
      const signed = await signMessage(request.params.message);

      await finish(request.id, signed);
      notify.success('Message signed');
    } catch (err) {
      notify.error(err);
      await sendInternal('approvals.reject', {
        id: request.id,
        error: { code: -32603, message: readableError(err) },
      });
      await loadNext();
    } finally {
      setIsBusy(false);
    }
  };

  //
  // Sign and send an arbitrary block
  //
  const approveSignAndSend = async () => {
    setIsBusy(true);

    try {
      authorizationMetadata(request.params.tokenStandard);
      const template = Primitives.AccountBlockTemplate.fromJson({
        ...request.params,
        amount: normalizeBaseUnits(request.params.amount),
      });
      const signed = await send(template);

      await finish(request.id, {
        hash: signed.hash?.toString(),
        block: signed.toJson?.() ?? null,
      });
      notify.success('Block sent');
    } catch (err) {
      notify.error(err);
      await sendInternal('approvals.reject', {
        id: request.id,
        error: { code: -32603, message: readableError(err) },
      });
      await loadNext();
    } finally {
      setIsBusy(false);
    }
  };

  if (request === undefined) {
    return (
      <div className="page approval-screen">
        <p className="empty-note">Loading request…</p>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="page approval-screen">
        {/* The queue is empty, but a site that has just been answered usually
            has one more thing to ask. Saying so beats flashing "Nothing to
            approve" at somebody for a second on the way to the next prompt. */}
        <p className="empty-note">
          {isWaitingForMore ? 'Waiting for the site…' : 'Nothing to approve.'}
        </p>
      </div>
    );
  }

  const busy = isBusy || isSending;
  // The site is blocked on the signed block, so this screen is the one place
  // that still waits — but it waits in place, on its own button, rather than
  // behind a modal that hides what is being approved.
  const busyLabel = isGeneratingPlasma ? 'Generating plasma…' : 'Sending…';

  // A site can ask for more than the account holds, and the wallet used to sign
  // it and let the node do the refusing — after the proof of work. Both request
  // shapes carry the amount and the token the same way, so one check covers a
  // plain transfer and an arbitrary block; a contract call with no value has an
  // amount of zero and never trips it.
  const shortfall = (() => {
    if (!['sendTransaction', 'signAndSendBlock'].includes(request.type)) {
      return null;
    }
    const { tokenStandard, amount } = request.params || {};
    let wanted;
    let metadata;
    try {
      metadata = authorizationMetadata(tokenStandard);
      wanted = toBigNumber(normalizeBaseUnits(amount));
    } catch (err) {
      return 'Invalid amount or token identifier.';
    }

    if (wanted.isZero()) {
      return null;
    }
    const entry = tokenFor(metadata.tokenStandard);

    if (!entry) {
      return 'This account holds none of that token.';
    }
    const balance = toBigNumber(entry.balance);

    if (!wanted.gt(balance)) {
      return null;
    }
    return `This account holds only ${formatExact(balance, metadata.decimals)} ${metadata.symbol}.`;
  })();

  return (
    <div className="page approval-screen">
      <SiteHeader request={request} />

      {request.type === 'connect' && (
        <>
          <div className="approval-body">
            <h2 className="approval-title">Connect this wallet?</h2>
            <p className="approval-note">
              {hostOf(request.origin)} will be able to see your address, the
              chain you are signing for and your node URL. It cannot move
              anything without asking again.
            </p>

            <dl className="confirm-details">
              <dt>Address</dt>
              <dd className="word-break-all">{address}</dd>
              <dt>Chain</dt>
              <dd>{chainIdentifier}</dd>
              <dt>Node</dt>
              <dd className="word-break-all">{nodeUrl}</dd>
            </dl>
          </div>

          <div className="action-row sticky-actions">
            <button
              type="button"
              className="button secondary w-100"
              onClick={reject}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button primary w-100 text-white"
              onClick={approveConnect}
              disabled={busy}
            >
              Connect
            </button>
          </div>
        </>
      )}

      {request.type === 'sendTransaction' && (
        <>
          <div className="approval-body">
            <h2 className="approval-title">Confirm transfer</h2>

            {(() => {
              const { to, tokenStandard, amount } = request.params;
              return (
                <dl className="confirm-details">
                  <TokenAmount amount={amount} tokenStandard={tokenStandard} />
                  <dt>To</dt>
                  <dd className="word-break-all">{to}</dd>
                  <dt>From</dt>
                  <dd title={address}>{truncateAddress(address, 10, 6)}</dd>
                </dl>
              );
            })()}

            {shortfall && (
              <p className="approval-warning" role="alert">
                {shortfall}
              </p>
            )}
          </div>

          <div className="action-row sticky-actions">
            <button
              type="button"
              className="button secondary w-100"
              onClick={reject}
            >
              Reject
            </button>
            <button
              type="button"
              className="button primary w-100 text-white"
              onClick={approveSendTransaction}
              disabled={busy || Boolean(shortfall)}
            >
              {busy ? busyLabel : 'Confirm'}
            </button>
          </div>
        </>
      )}

      {request.type === 'signMessage' && (
        <>
          <div className="approval-body">
            <h2 className="approval-title">Sign this message?</h2>
            <p className="approval-note">
              A signature proves this address is yours. It moves nothing, costs
              no plasma and is never published — but only sign what you can
              read, and only for a site you meant to sign in to.
            </p>

            {/* Verbatim, wrapped, and never interpreted: the point of this
                panel is that what gets signed is what is on screen. */}
            <pre className="message-preview">{request.params.message}</pre>

            <dl className="confirm-details">
              <dt>Signing as</dt>
              <dd title={address}>{truncateAddress(address, 10, 6)}</dd>
            </dl>
          </div>

          <div className="action-row sticky-actions">
            <button
              type="button"
              className="button secondary w-100"
              onClick={reject}
            >
              Reject
            </button>
            <button
              type="button"
              className="button primary w-100 text-white"
              onClick={approveSignMessage}
              disabled={busy}
            >
              {isBusy ? 'Signing…' : 'Sign'}
            </button>
          </div>
        </>
      )}

      {request.type === 'signAndSendBlock' && (
        <>
          <div className="approval-body">
            <h2 className="approval-title">Sign this block?</h2>

            {(() => {
              const json = preview ?? request.params;
              const info = describeBlock(json);
              const amountRow = info.hasAmount && (
                <TokenAmount amount={info.amount} tokenStandard={info.tokenStandard} />
              );

              if (info.kind === 'unknownCall') {
                return (
                  <>
                    <p className="approval-warning" role="alert">
                      This calls the {info.contract} contract with a method
                      this wallet does not recognize. Read the raw data below
                      before approving.
                    </p>
                    <dl className="confirm-details">
                      <dt>Contract</dt>
                      <dd>{info.contract}</dd>
                      {amountRow}
                    </dl>
                  </>
                );
              }

              if (info.kind === 'knownCall') {
                return (
                  <>
                    <p className="approval-note">
                      This calls the embedded {info.contract} contract.
                    </p>
                    <dl className="confirm-details">
                      <dt>Action</dt>
                      <dd>{info.label}</dd>
                      <dt>Contract</dt>
                      <dd>{info.contract}</dd>
                      {amountRow}
                    </dl>
                  </>
                );
              }

              return (
                <>
                  <p className="approval-note">
                    This is a plain transfer to an ordinary address. Not a
                    contract call.
                  </p>
                  <dl className="confirm-details">
                    {amountRow || (
                      <>
                        <dt>Amount</dt>
                        <dd>Nothing</dd>
                      </>
                    )}
                    <dt>To</dt>
                    <dd className="word-break-all">{info.to}</dd>
                    <dt>From</dt>
                    <dd title={address}>{truncateAddress(address, 10, 6)}</dd>
                  </dl>
                </>
              );
            })()}

            <details className="block-preview-details">
              <summary>Raw transaction data</summary>
              <pre className="block-preview">
                {JSON.stringify(preview ?? request.params, null, 2)}
              </pre>
            </details>

            {shortfall && (
              <p className="approval-warning" role="alert">
                {shortfall}
              </p>
            )}
          </div>

          <div className="action-row sticky-actions">
            <button
              type="button"
              className="button secondary w-100"
              onClick={reject}
            >
              Reject
            </button>
            <button
              type="button"
              className="button warning w-100"
              onClick={approveSignAndSend}
              disabled={busy || Boolean(shortfall)}
            >
              {busy ? busyLabel : 'Sign and send'}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default SiteIntegrationLayout;
