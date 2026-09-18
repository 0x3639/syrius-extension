import { useEffect, useRef, useState } from 'react';

import { fetchTokenPrices } from '../utils/tokenPrice';

// How often to ask CoinGecko while the dashboard is open and pointed at
// mainnet — often enough that a price feels live, comfortably inside
// CoinGecko's public rate limit.
const pollIntervalMs = 60000;

// Live ZNN/QSR USD prices, polled only while `enabled`. A price is a fact
// about mainnet specifically — a devnet or a private chain has no coin for
// CoinGecko to have an opinion about — so this is left off until the caller
// has confirmed the connected node actually is mainnet, rather than polling
// unconditionally and showing a mainnet price beside a devnet balance.
const usePriceFeed = (enabled) => {
  const [prices, setPrices] = useState({ znn: null, qsr: null });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setPrices({ znn: null, qsr: null });
      return undefined;
    }
    let cancelled = false;

    const poll = async () => {
      try {
        const next = await fetchTokenPrices();

        if (!cancelled && mounted.current) {
          setPrices(next);
        }
      } catch (err) {
        // A quiet tick is better than a wallet that throws over a price feed.
        // Whatever was last fetched stays on screen rather than blanking out.
      }
    };

    poll();
    const timer = setInterval(poll, pollIntervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  return prices;
};

export default usePriceFeed;
