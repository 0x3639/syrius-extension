// Live USD prices for ZNN and QSR, from CoinGecko's public price endpoint.
//
// Neither token's CoinGecko id is its ticker. ZNN is listed as `zenon-2` —
// plain `zenon` belongs to an unrelated project — and QSR as `quasar`. This is
// the same mapping zenonhub's own price service uses (`TokenPrice.php` in
// `zenonhub-io/zenonhub`), cross-checked against the coin's own CoinGecko page.

const coingeckoIds = {
  znn: 'zenon-2',
  qsr: 'quasar',
};

const priceUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoIds.znn},${coingeckoIds.qsr}&vs_currencies=usd`;

// `null` for either token the response did not carry a price for, rather than
// throwing — a price feed having nothing to say about one token is not reason
// enough to take the whole dashboard down.
const fetchTokenPrices = async () => {
  const response = await fetch(priceUrl);

  if (!response.ok) {
    throw new Error(`CoinGecko responded ${response.status}`);
  }
  const json = await response.json();

  const priceOf = (id) => {
    const value = json?.[id]?.usd;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };

  return {
    znn: priceOf(coingeckoIds.znn),
    qsr: priceOf(coingeckoIds.qsr),
  };
};

export { coingeckoIds, fetchTokenPrices };
