import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Primitives } from 'znn-ts-sdk';
import { useForm } from 'react-hook-form';

import TokenAmount from '../../../components/token-amount/token-amount';
import { authorizationMetadata, parseTransferAmount, prepareTransfer } from '../../../services/wallet/tokenMetadata';
import AlertModal from '../../../components/modals/alert-modal';
import ControlledDropdown from '../../../components/custom-dropdown/controlled-dropdown';
import { ModalContext } from '../../../services/hooks/modal/modalContext';
import useAccount from '../../../services/hooks/useAccount';
import useBackgroundSender from '../../../services/hooks/useBackgroundSender';
import {
  formatAmount,
  formatExact,
  toBigNumber,
} from '../../../services/utils/format';
import { notify } from '../../../services/utils/notify';
import { znnZts } from '../../../services/wallet/account';

// Sending.
//
// Three things were wrong here and all three could cost somebody money.
//
//   1. The amount was converted with `parseInt(amount * Math.pow(10, decimals))`.
//      Binary floating point cannot hold 4.35, so `4.35 * 1e8` is
//      434999999.99999994 and `parseInt` takes the floor: the block was built
//      for one base unit less than was typed. It also silently truncated
//      anything a double cannot represent, which is every amount over about
//      90 million ZNN.
//   2. The maximum was the literal `999`. Sending 1000 ZNN failed validation on
//      an account holding ten thousand, and the real balance was sitting right
//      there in a commented-out line above it.
//   3. The recipient was checked for being non-empty and nothing else. An
//      address with a typo in it got as far as the confirmation dialog and then
//      came back as a node error after the user had already confirmed.

const Send = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { address, balances, balanceMap } = useAccount();
  const { openModal } = useContext(ModalContext);
  const { sendInBackground } = useBackgroundSender();

  const [selectedToken, setSelectedToken] = useState(
    location.state?.currentSelectedToken || znnZts
  );
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');

  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
    reset,
    setValue,
    trigger,
  } = useForm({ mode: 'onChange' });

  const selected = balanceMap[selectedToken];
  const { decimals, symbol, isNative } = authorizationMetadata(selectedToken);
  const current = useRef();
  current.current = { address, selectedToken, balanceMap };

  // Through `toBigNumber`, because a balance reaches here as a BigNumber from
  // the node, as the number 0 from the placeholder token map, or as undefined
  // for a token this account holds none of.
  const balance = useMemo(() => toBigNumber(selected?.balance), [selected]);

  const maxAmount = useMemo(
    () => formatAmount(balance, decimals, { maxDecimals: decimals ?? 8, group: false }),
    [balance, decimals]
  );

  useEffect(() => {
    setValue('selectedTokenField', selectedToken, { shouldValidate: true });
  }, [selectedToken, setValue]);

  // Comparing base units rather than parsed floats, so a balance that a double
  // cannot represent still validates correctly.
  const validateAmount = (input) => {
    const parsed = parseTransferAmount(input, selectedToken);

    if (parsed === null) {
      return isNative ? `Enter an amount with at most ${decimals} decimals` : 'Enter an integer number of base units';
    }
    if (parsed.isZero()) {
      return 'Amount must be more than zero';
    }
    // Unconditional: an account holding none of the selected token has a
    // balance of literal 0, which is falsy, so the old `selected?.balance && …`
    // guard skipped the comparison for exactly the case it was there to catch.
    if (parsed.gt(balance)) {
      return balance.isZero()
        ? `You have no ${symbol || 'balance'} to send`
        : `You only have ${maxAmount} ${symbol}`;
    }
    return true;
  };

  // The balance changes under this form in two ways: the first response after
  // mount, and switching token. Either can make a typed amount valid or invalid
  // without a keystroke to re-check it.
  useEffect(() => {
    if (amount) {
      trigger('sendAmountField');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balance.toString(), selectedToken]);

  const validateRecipient = (input) => {
    try {
      Primitives.Address.parse((input || '').trim());
      return true;
    } catch (err) {
      return 'That is not a valid Zenon address';
    }
  };

  // Nothing here is awaited. Building and signing the block can take seconds of
  // proof of work on an account with no fused plasma, and the wallet used to
  // spend them behind a modal spinner on this screen. The block goes off to the
  // background sender, the form empties, and the dashboard reports the rest.
  const submit = (review) => {
    // A metadata refresh cannot reinterpret an already reviewed quantity.
    // An account or token selection change requires another confirmation.
    if (current.current.address !== review.owner || current.current.selectedToken !== review.tokenStandard) {
      notify.error('The account or token changed. Review this transfer again.');
      return;
    }
    try {
      const parsed = toBigNumber(review.amount);
      const latestBalance = current.current.balanceMap[review.tokenStandard]?.balance;
      if (parsed.gt(toBigNumber(latestBalance))) {
        throw new Error('Not enough balance for this transfer');
      }
      const template = Primitives.AccountBlockTemplate.send(
        Primitives.Address.parse(review.recipient),
        Primitives.TokenStandard.parse(review.tokenStandard),
        parsed
      );

      sendInBackground(template, {
        successMessage: `Sent ${formatExact(review.amount, review.decimals)} ${review.symbol}`,
        // What the dashboard needs to draw the row, since the block will not be
        // in the account's history until this finishes.
        row: {
          // Which account this belongs to, so switching address does not show
          // a send made from the previous one. The type, glyph and destination
          // come off the template.
          owner: review.owner,
          label: 'Sending',
          amount: parsed.toString(),
          decimals: review.decimals,
          tokenSymbol: review.symbol,
        },
      });

      setAmount('');
      setRecipient('');
      reset();
      navigate('/tabs/dashboard');
    } catch (err) {
      // Only a block that could not even be built reaches here; anything the
      // node rejects is reported on the row instead.
      notify.error(err);
    }
  };

  const confirm = () => {
    try {
      const review = prepareTransfer({ tokenStandard: selectedToken, amount, recipient, owner: address, balance });
      openModal(
        <AlertModal
          type="confirm"
          title="Confirm send"
          confirmLabel="Send"
          onSuccess={() => submit(review)}
        >
          <dl className="confirm-details">
            <TokenAmount amount={review.amount} tokenStandard={review.tokenStandard} />
            <dt>To</dt>
            <dd className="word-break-all">{review.recipient}</dd>
          </dl>
        </AlertModal>
      );
    } catch (err) {
      notify.error(err);
    }
  };

  return (
    <div className="page">
      <form onSubmit={handleSubmit(confirm)}>
        {!isNative && (
          <p className="approval-warning">
            Custom token details are unverified. Enter whole base units and check the full token identifier at confirmation.
          </p>
        )}
        <div className="custom-control">
          <ControlledDropdown
            dropdownComponent="TokenDropdown"
            {...register('selectedTokenField', { required: true })}
            control={control}
            name="selectedTokenField"
            options={balances}
            onChange={(index, value) => setSelectedToken(value.token.tokenStandard.toString())}
            value={selectedToken}
            placeholder="Select token"
            tokenSymbolPath="token.symbol"
            tokenStandardPath="token.tokenStandard"
            className={errors.selectedTokenField ? 'custom-label-error' : ''}
          />
          <div className={`input-error ${errors.selectedTokenField ? '' : 'invisible'}`}>
            Choose a token
          </div>
        </div>

        <div className="custom-control">
          <div className="input-with-button w-100">
            <input
              {...register('sendAmountField', { required: true, validate: validateAmount })}
              className={`w-100 custom-label pr-3 ${
                errors.sendAmountField ? 'custom-label-error' : ''
              }`}
              placeholder={isNative ? `${symbol} amount` : 'Base units (integer)'}
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setValue('sendAmountField', event.target.value, { shouldValidate: true });
              }}
              inputMode="decimal"
              type="text"
            />
            <button
              type="button"
              className="input-chip-button"
              title={`Balance ${formatExact(selected?.balance, decimals)} ${symbol}`}
              onClick={() => {
                setAmount(maxAmount);
                setValue('sendAmountField', maxAmount, { shouldValidate: true });
              }}
            >
              Max
            </button>
          </div>
          <div className={`input-error ${errors.sendAmountField ? '' : 'invisible'}`}>
            {errors.sendAmountField?.message || 'Amount is required'}
          </div>
        </div>

        <div className="custom-control">
          <input
            {...register('recipientAddressField', { required: true, validate: validateRecipient })}
            className={`w-100 custom-label ${
              errors.recipientAddressField ? 'custom-label-error' : ''
            }`}
            placeholder="Recipient address"
            value={recipient}
            onChange={(event) => {
              setRecipient(event.target.value);
              setValue('recipientAddressField', event.target.value, { shouldValidate: true });
            }}
            type="text"
            spellCheck="false"
            autoComplete="off"
          />
          <div className={`input-error ${errors.recipientAddressField ? '' : 'invisible'}`}>
            {errors.recipientAddressField?.message || 'Address is required'}
          </div>
        </div>

        <div className="action-row sticky-actions">
          <button type="button" className="button secondary w-100" onClick={() => navigate(-1)}>
            Back
          </button>
          {/* No pending state: confirming leaves this screen immediately, and
              the send reports itself on the dashboard from there. */}
          <button type="submit" className="button primary w-100 text-white">
            Send
          </button>
        </div>
      </form>
    </div>
  );
};

export default Send;
