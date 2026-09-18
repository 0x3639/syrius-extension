import { useCallback, useEffect, useRef, useState } from 'react';

import useDelayedFlag from './useDelayedFlag';

// Paging a list from an embedded-contract RPC.
//
// Four screens carried their own copy of this: a `useRef` observer, a
// `document.getElementById` for the sentinel, a page counter and a
// `shouldLoadMore` boolean. All four decided whether more pages existed with
// `if (response.count >= items.length) setShouldLoadMore(true)`, which is true
// whenever the list is not over-full — so the flag stayed on, the observer kept
// firing, and the same page was fetched again for as long as the sentinel was
// on screen. They also read `items` through a `let` rebound from inside the
// state updater, so the comparison was against whatever that closure last saw.
//
// A short page means the end. That is the whole rule.

const usePagedList = (fetchPage, { pageSize = 10, enabled = true } = {}) => {
  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);

  const page = useRef(0);
  const loading = useRef(false);
  const mounted = useRef(true);
  const sentinelRef = useRef(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadMore = useCallback(async () => {
    if (!enabled || loading.current || !hasMore) {
      return;
    }
    loading.current = true;
    setIsLoading(true);

    try {
      const response = await fetchPage(page.current, pageSize);
      const list = response?.list || [];

      if (!mounted.current) {
        return;
      }
      // Whatever the caller wants off the response besides the rows — the total
      // fused QSR, say, which comes back on the same call.
      setMeta(response ?? null);
      setItems((previous) => [...previous, ...list]);
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
  }, [enabled, fetchPage, hasMore, pageSize]);

  const reset = useCallback(() => {
    page.current = 0;
    loading.current = false;
    setItems([]);
    setHasMore(true);
    setError(null);
  }, []);

  // The sentinel is a ref rather than an id lookup, so a screen cannot observe
  // another screen's leftover element — which is what happened when two of
  // these mounted during a route transition.
  useEffect(() => {
    const sentinel = sentinelRef.current;

    if (!sentinel || !enabled) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { threshold: 1.0 }
    );
    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [enabled, loadMore]);

  // For display only: whether to actually show a "Loading…" label. See
  // `useDelayedFlag`.
  const showLoading = useDelayedFlag(isLoading);

  return {
    items,
    meta,
    isLoading,
    showLoading,
    hasMore,
    error,
    sentinelRef,
    loadMore,
    reset,
    isEmpty: !items.length && !hasMore,
  };
};

export default usePagedList;
