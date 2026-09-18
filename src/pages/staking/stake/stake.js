import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { Zenon } from 'znn-ts-sdk';

import AlertModal from '../../../components/modals/alert-modal';
import ControlledDropdown from '../../../components/custom-dropdown/controlled-dropdown';
import StakeItem from '../../../components/stake-item/stake-item';
import { ModalContext } from '../../../services/hooks/modal/modalContext';
import useAccount from '../../../services/hooks/useAccount';
import useBackgroundSender from '../../../services/hooks/useBackgroundSender';
import usePagedList from '../../../services/hooks/usePagedList';
import vault from '../../../services/wallet/vault';
import { znnZts } from '../../../services/wallet/account';
import fallbackValues from '../../../services/utils/fallbackValues';
import { formatAmount, formatExact, parseAmount, toBigNumber, toDecimals } from '../../../services/utils/format';
import { notify } from '../../../services/utils/notify';

// Staking.
//
// Two real defects. The amount was converted with
// `parseInt(toStakeAmount) * Math.pow(10, 8)`, and `parseInt("1.5")` is 1 — so
// staking 1.5 ZNN silently staked one, locked for the chosen period, with the
// wallet reporting success. And "Staked N ZNN" read from `stakedZnnAmount`,
// a state value that was declared, initialised to 0, and never assigned; the
// total was therefore always zero however much was staked.

const Stake = () => {
  const navigate = useNavigate();
  const { address, balanceMap } = useAccount();
  const { openModal } = useContext(ModalContext);
  const { sendInBackground } = useBackgroundSender();

  const [addressObject, setAddressObject] = useState(null);
  const [amount, setAmount] = useState('');
  const [duration, setDuration] = useState('');
  const [uncollectedQsr, setUncollectedQsr] = useState(0);

  const znn = balanceMap[znnZts];
  const decimals = toDecimals(znn?.token?.decimals);

  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
    reset: resetForm,
    setValue,
    trigger,
  } = useForm({ mode: 'onChange' });

  const loadRewards = useCallback(async (object) => {
    try {
      const uncollected = await Zenon.getSingleton().embedded.stake.getUncollectedReward(object);
      setUncollectedQsr(uncollected?.qsrAmount ?? 0);
    } catch (err) {
      // Reported by the header.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    vault
      .getAddressObject()
      .then((object) => {
        if (cancelled) {
          return;
        }
        setAddressObject(object);
        loadRewards(object);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [loadRewards]);

  const fetchPage = useCallback(
    (page, pageSize) =>
      Zenon.getSingleton().embedded.stake.getEntriesByAddress(addressObject, page, pageSize),
    [addressObject]
  );

  const entries = usePagedList(fetchPage, { pageSize: 10, enabled: Boolean(addressObject) });

  // The total that was always zero. `StakeList` carries it on the same paged
  // response the entries come back on.
  const stakedTotal = entries.meta?.totalAmount;

  // Through `toBigNumber`, because a balance reaches here as a BigNumber from
  // the node, as the number 0 from the placeholder token map, or as undefined
  // before the first response.
  const znnBalance = useMemo(() => toBigNumber(znn?.balance), [znn]);

  const maxAmount = useMemo(
    () => formatAmount(znnBalance, decimals, { maxDecimals: decimals, group: false }),
    [znnBalance, decimals]
  );

  const validateAmount = (input) => {
    const parsed = parseAmount(input, decimals);

    if (parsed === null) {
      return 'Enter a ZNN amount';
    }
    // The stake contract's floor is one ZNN.
    if (parsed.lt(parseAmount('1', decimals))) {
      return 'Minimum of 1 ZNN';
    }
    // Unconditional: an account holding no ZNN has a balance of literal 0,
    // which is falsy, so the old `znn?.balance && …` guard skipped the
    // comparison for exactly the account that needed it.
    if (parsed.gt(znnBalance)) {
      return znnBalance.isZero() ? 'You have no ZNN to stake' : `You only have ${maxAmount} ZNN`;
    }
    return true;
  };

  // Balances arrive after the first render, so an amount typed against the
  // placeholder zero has to be re-checked when the real one lands.
  useEffect(() => {
    if (amount) {
      trigger('stakeAmountField');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [znnBalance.toString()]);

  const stake = () => {
    // Checked again here, not just in the form. The confirmation modal sits
    // between validation and this, and a balance can move underneath it.
    const problem = validateAmount(amount);

    if (problem !== true) {
      notify.error(problem);
      return;
    }

    try {
      const parsed = parseAmount(amount, decimals);
      const template = Zenon.getSingleton().embedded.stake.stake(Number(duration), parsed);

      sendInBackground(template, {
        successMessage: `Staked ${amount} ZNN`,
        row: {
          owner: address,
          label: `Staking ${amount} ZNN`,
          amount: parsed.toString(),
          decimals,
          tokenSymbol: znn?.token?.symbol || 'ZNN',
        },
      });

      setAmount('');
      setDuration('');
      resetForm();
      navigate('/tabs/dashboard');
    } catch (err) {
      notify.error(err);
    }
  };

  const withdraw = (id) => {
    try {
      sendInBackground(Zenon.getSingleton().embedded.stake.cancel(id), {
        successMessage: 'Stake withdrawn',
        row: { owner: address, label: 'Withdrawing stake' },
      });

      navigate('/tabs/dashboard');
    } catch (err) {
      notify.error(err);
    }
  };

  const collect = () => {
    try {
      sendInBackground(Zenon.getSingleton().embedded.stake.collectReward(), {
        successMessage: 'Rewards collected',
        row: { owner: address, label: 'Collecting rewards' },
      });

      navigate('/tabs/dashboard');
    } catch (err) {
      notify.error(err);
    }
  };

  const months = duration ? Math.round(Number(duration) / 2592000) : 0;

  const confirmStake = () =>
    openModal(
      <AlertModal type="confirm" title="Stake ZNN" confirmLabel="Stake" onSuccess={stake}>
        <p>
          Lock <b>{amount} ZNN</b> for <b>{months} month{months === 1 ? '' : 's'}</b>? It cannot be
          withdrawn before then.
        </p>
      </AlertModal>
    );

  const hasRewards = !toBigNumber(uncollectedQsr).isZero();

  return (
    <div className="page">
      <div className="stat-row">
        <div>
          <div className="stat-value" title={formatExact(stakedTotal, decimals)}>
            {formatAmount(stakedTotal, decimals)} ZNN
          </div>
          <div className="stat-label">Staked</div>
        </div>
        <button
          type="button"
          className="thin-button blue"
          onClick={collect}
          disabled={!hasRewards}
        >
          Collect {formatAmount(uncollectedQsr, 8)} QSR
        </button>
      </div>

      <form id="stakeForm" className="fields-only" onSubmit={handleSubmit(confirmStake)}>
        <div className="custom-control">
          <div className="input-with-button w-100">
            <input
              {...register('stakeAmountField', { required: true, validate: validateAmount })}
              className={`w-100 custom-label pr-3 ${
                errors.stakeAmountField ? 'custom-label-error' : ''
              }`}
              placeholder="ZNN to stake"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setValue('stakeAmountField', event.target.value, { shouldValidate: true });
              }}
              inputMode="decimal"
              type="text"
            />
            <button
              type="button"
              className="input-chip-button"
              onClick={() => {
                setAmount(maxAmount);
                setValue('stakeAmountField', maxAmount, { shouldValidate: true });
              }}
            >
              Max
            </button>
          </div>
          <div className={`input-error ${errors.stakeAmountField ? '' : 'invisible'}`}>
            {errors.stakeAmountField?.message || 'Amount is required'}
          </div>
        </div>

        <div className="custom-control">
          <ControlledDropdown
            dropdownComponent="CustomDropdown"
            {...register('stakeDurationField', { required: true })}
            control={control}
            name="stakeDurationField"
            options={fallbackValues.stakingDurations}
            onChange={(index, option) => {
              setDuration(option.value);
              setValue('stakeDurationField', option.value, { shouldValidate: true });
            }}
            value={fallbackValues.stakingDurations.find((entry) => entry.value === duration)}
            placeholder="Lock period"
            displayKey="label"
            className={errors.stakeDurationField ? 'custom-label-error' : ''}
          />
          <div className={`input-error ${errors.stakeDurationField ? '' : 'invisible'}`}>
            Choose how long to lock
          </div>
        </div>
      </form>

      {/* No pending state: confirming leaves this screen immediately and the
          stake reports itself on the dashboard from there. */}
      <button type="submit" form="stakeForm" className="button primary w-100 text-white">
        Stake ZNN
      </button>

      <div className="list mt-3">
        {entries.items.map((entry) => (
          <StakeItem
            key={entry.id.toString()}
            id={entry.id}
            amount={entry.amount}
            decimals={decimals}
            startTimestamp={entry.startTimestamp}
            expirationTimestamp={entry.expirationTimestamp}
            cancelStake={withdraw}
          />
        ))}

        {entries.isEmpty && <p className="empty-note">Nothing staked yet</p>}

        <div ref={entries.sentinelRef} className="load-more-sentinel">
          {entries.showLoading && <span className="text-gray">Loading…</span>}
        </div>
      </div>
    </div>
  );
};

export default Stake;
