import { useCallback, useEffect, useRef, useState } from 'react';
import { Zenon } from 'znn-ts-sdk';

import { embeddedContractName } from '../utils/contracts';
import { decodeCall, describeCall, contractDisplayName } from '../utils/contractCalls';
// Shared with the in-flight rows on the dashboard, so a block looks the same
// on its way out as it does once it has landed.
import { iconForContract } from '../utils/outgoingBlock';

// Account history, paged.
//
// The dashboard asked for 200 blocks at a time and then, for every one of them
// that was a receive, made a second call to look up the block it referenced —
// so opening the wallet could fire two hundred sequential RPC calls before it
// drew anything. Twenty is more than fits on the screen, and the lookups for a
// page run together rather than one after another.

const pageSize = 20;

// What a block did, from the block itself.
//
// The old version compared the destination against three address constants and
// called everything else "sent", so a fuse and an unfuse were both "Fused", a
// stake and an unstake were both "Staked", and a swap was "Sent 0".
const identify = (block, myAddress) => {
  const to = block.toAddress?.toString();
  const from = block.address?.toString();

  if (to === myAddress) {
    // Incoming. A payout from a contract — a collected reward, a returned
    // stake, an unlocked swap — is named after the contract that sent it,
    // because the sending block carries no call data of its own.
    const fromContract = embeddedContractName(from);

    return {
      type: 'received',
      label: 'Received',
      icon: 'receive',
      counterpartyName: fromContract ? contractDisplayName(fromContract) : null,
    };
  }

  const contract = embeddedContractName(to);

  if (!contract) {
    return { type: 'sent', label: 'Sent', icon: 'send', counterpartyName: null };
  }

  const method = decodeCall(contract, block.data);

  return {
    type: contract,
    label: describeCall(contract, method),
    icon: iconForContract[contract] || 'contract',
    counterpartyName: contractDisplayName(contract),
    method,
  };
};

const useTransactions = (addressObject, address) => {
  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState(null);

  const page = useRef(0);
  const loading = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A receive block carries no amount of its own — the value is on the send
  // block it points at, so that one has to be fetched to render the row.
  const expand = useCallback(async (zenon, block) => {
    const json = block.toJson();
    const isReceive = Number(json.blockType) === 3;

    if (!isReceive) {
      return json;
    }
    try {
      return (await zenon.ledger.getBlockByHash(json.fromBlockHash)).toJson();
    } catch (err) {
      // A block the node cannot resolve is still worth showing as a row.
      return json;
    }
  }, []);

  const transform = useCallback(
    (block, own) => {
      const { type, label, icon, counterpartyName, method } = identify(block, address);

      return {
        type,
        label,
        icon,
        method,
        counterpartyName,
        // A contract call moves no coins of its own; showing "0 ZNN" against a
        // delegation reads as a failed transfer.
        amount: block.amount ?? 0,
        decimals: block.token?.decimals,
        tokenSymbol: block.token?.symbol || '',
        // The other side of the transfer. For a receive, `block` is the
        // origin send block (see `expand`), and on that block `toAddress` is
        // this account, not the counterparty — the sender is `address`. A
        // receive block's own `address`/`toAddress` pair (burn address as the
        // destination) carries no such thing.
        address: (type === 'received' ? block.address : block.toAddress)?.toString() || '',
        // The block that actually carries this transfer, for the explorer
        // link: the origin send block for a receive (again, what `block` is
        // once expanded), the account's own block otherwise. Confirmation
        // status is still read from `own` below — that's a fact about the
        // block in my chain, and for a receive the referenced send block was
        // confirmed long before mine was.
        hash: block.hash,
        isUnconfirmed: !own.confirmationDetail,
        confirmations: own.confirmationDetail?.numConfirmations ?? 0,
      };
    },
    [address]
  );

  const loadMore = useCallback(async () => {
    if (loading.current || !hasMore || !addressObject || !address) {
      return;
    }
    loading.current = true;
    setIsLoading(true);

    try {
      const zenon = Zenon.getSingleton();
      const response = await zenon.ledger.getBlocksByPage(addressObject, page.current, pageSize);
      const list = response?.list || [];

      if (!list.length) {
        setHasMore(false);
        return;
      }

      const expanded = await Promise.all(list.map((block) => expand(zenon, block)));
      const rows = expanded.map((block, index) => transform(block, list[index]));

      if (!mounted.current) {
        return;
      }
      setItems((previous) => [...previous, ...rows]);
      setError(null);
      page.current += 1;
      setHasMore(list.length === pageSize);
    } catch (err) {
      if (mounted.current) {
        setError(err);
        setHasMore(false);
      }
    } finally {
      loading.current = false;
      if (mounted.current) {
        setIsLoading(false);
      }
    }
  }, [addressObject, address, expand, hasMore, transform]);

  // Re-reads the newest page and folds it into what is already on screen.
  //
  // A block is unconfirmed for as long as it takes the network to produce a
  // momentum over it, which is around ten seconds — long enough that the wallet
  // has to notice on its own. Resetting the list instead would throw away every
  // page the person had scrolled through, so rows are matched by hash: an
  // existing one is replaced (which is what turns off its pulse) and anything
  // genuinely new goes on top.
  const refreshNewest = useCallback(async () => {
    if (!addressObject || !address) {
      return;
    }
    try {
      const zenon = Zenon.getSingleton();
      const response = await zenon.ledger.getBlocksByPage(addressObject, 0, pageSize);
      const list = response?.list || [];

      if (!list.length || !mounted.current) {
        return;
      }
      const expanded = await Promise.all(list.map((block) => expand(zenon, block)));
      const rows = expanded.map((block, index) => transform(block, list[index]));

      if (!mounted.current) {
        return;
      }
      setItems((previous) => {
        const known = new Set(previous.map((row) => row.hash));
        const updated = previous.map((row) => rows.find((fresh) => fresh.hash === row.hash) || row);
        const added = rows.filter((row) => !known.has(row.hash));
        return [...added, ...updated];
      });
    } catch (err) {
      // A failed refresh leaves the list exactly as it was.
    }
  }, [addressObject, address, expand, transform]);

  const reset = useCallback(() => {
    page.current = 0;
    loading.current = false;
    setItems([]);
    setHasMore(true);
    setError(null);
  }, []);

  return {
    items,
    isLoading,
    hasMore,
    error,
    loadMore,
    reset,
    refreshNewest,
    hasPending: items.some((row) => row.isUnconfirmed),
    isEmpty: !items.length && !hasMore,
  };
};

export default useTransactions;
