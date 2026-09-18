import React, { useCallback, useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zenon } from 'znn-ts-sdk';

import AlertModal from '../../components/modals/alert-modal';
import PillarItem from '../../components/pillar-item/pillar-item';
import { ModalContext } from '../../services/hooks/modal/modalContext';
import useBackgroundSender from '../../services/hooks/useBackgroundSender';
import usePagedList from '../../services/hooks/usePagedList';
import useAccount from '../../services/hooks/useAccount';
import vault from '../../services/wallet/vault';
import { formatAmount } from '../../services/utils/format';
import { notify } from '../../services/utils/notify';

// Delegation.
//
// The uncollected rewards were divided by the wrong token's decimals — the ZNN
// amount by QSR's and the QSR amount by ZNN's. Both happen to be 8 today, so
// nothing was visibly wrong, but the two lines were one differing token away
// from showing numbers off by orders of magnitude.

const Delegate = () => {
  const navigate = useNavigate();
  const { address } = useAccount({ balances: false });
  const { openModal } = useContext(ModalContext);
  const { sendInBackground } = useBackgroundSender();

  const [delegated, setDelegated] = useState(null);
  const [rewards, setRewards] = useState({ znn: 0, qsr: 0 });

  const loadDelegation = useCallback(async (object) => {
    const zenon = Zenon.getSingleton();

    try {
      const [pillar, uncollected] = await Promise.all([
        zenon.embedded.pillar.getDelegatedPillar(object),
        zenon.embedded.pillar.getUncollectedReward(object),
      ]);
      setDelegated(pillar && pillar.name ? pillar : null);
      setRewards({ znn: uncollected?.znnAmount ?? 0, qsr: uncollected?.qsrAmount ?? 0 });
    } catch (err) {
      // The header already reports a node that cannot be reached.
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
        loadDelegation(object);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [loadDelegation]);

  const fetchPage = useCallback(
    (page, pageSize) => Zenon.getSingleton().embedded.pillar.getAll(page, pageSize),
    []
  );

  const pillars = usePagedList(fetchPage, { pageSize: 10 });

  // Builds the block, hands it to the background sender and goes home. Nothing
  // here waits on proof of work; the dashboard reports it instead.
  const runInBackground = async (buildTemplate, label, successMessage) => {
    try {
      sendInBackground(await buildTemplate(), {
        successMessage,
        row: { owner: address, label },
      });

      navigate('/tabs/dashboard');
    } catch (err) {
      notify.error(err);
    }
  };

  const delegate = (name) =>
    openModal(
      <AlertModal
        type="confirm"
        title="Delegate"
        confirmLabel="Delegate"
        onSuccess={() =>
          runInBackground(
            () => Zenon.getSingleton().embedded.pillar.delegate(name),
            `Delegating to ${name}`,
            `Delegated to ${name}`
          )
        }
      >
        <p>
          Delegate your weight to <b>{name}</b>? Your ZNN stays in your wallet and can be
          undelegated at any time.
        </p>
      </AlertModal>
    );

  const undelegate = () =>
    openModal(
      <AlertModal
        type="warning"
        title="Undelegate"
        confirmLabel="Undelegate"
        onSuccess={() =>
          runInBackground(
            () => Zenon.getSingleton().embedded.pillar.undelegate(),
            'Undelegating',
            'Undelegated'
          )
        }
      >
        <p>Stop delegating to {delegated?.name}? You stop earning delegation rewards.</p>
      </AlertModal>
    );

  const collect = () =>
    runInBackground(
      () => Zenon.getSingleton().embedded.pillar.collectReward(),
      'Collecting rewards',
      'Rewards collected'
    );

  const hasRewards =
    formatAmount(rewards.znn, 8) !== '0' || formatAmount(rewards.qsr, 8) !== '0';

  return (
    <div className="page">
      {delegated && (
        <div className="stat-row">
          <div>
            <div className="stat-value">{delegated.name}</div>
            <div className="stat-label">
              Delegated · {formatAmount(delegated.weightWithDecimals, 0, { maxDecimals: 0 })} weight
            </div>
          </div>
          <button type="button" className="thin-button secondary" onClick={undelegate}>
            Undelegate
          </button>
        </div>
      )}

      {hasRewards && (
        <div className="stat-row">
          <div>
            <div className="stat-value">
              {formatAmount(rewards.znn, 8)} ZNN · {formatAmount(rewards.qsr, 8)} QSR
            </div>
            <div className="stat-label">Uncollected rewards</div>
          </div>
          <button
            type="button"
            className="thin-button primary"
            onClick={collect}
          >
            Collect
          </button>
        </div>
      )}

      <div className="list mt-2">
        {pillars.items.map((pillar) => (
          <PillarItem
            key={pillar.name}
            name={pillar.name}
            giveDelegateRewardPercentage={pillar.giveDelegateRewardPercentage}
            weight={pillar.weight}
            producedMomentums={pillar.currentStats?.producedMomentums}
            expectedMomentums={pillar.currentStats?.expectedMomentums}
            producerAddress={pillar.producerAddress?.toString() || ''}
            isDelegatedPillar={pillar.name === delegated?.name}
            onDelegate={delegate}
            onUndelegate={undelegate}
          />
        ))}

        {pillars.isEmpty && <p className="empty-note">No pillars found</p>}

        <div ref={pillars.sentinelRef} className="load-more-sentinel">
          {pillars.showLoading && <span className="text-gray">Loading…</span>}
        </div>
      </div>
    </div>
  );
};

export default Delegate;
