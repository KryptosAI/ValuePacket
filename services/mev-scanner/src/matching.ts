/**
 * Pure DEX pair matching and MEV opportunity computation.
 * No side effects — safe to import in unit tests.
 */

export const MIN_LIQUIDITY_USD = 10_000;
export const MAX_OPPORTUNITIES = 3;

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { symbol: string };
  quoteToken: { symbol: string };
  priceUsd: string;
  liquidity: { usd: number };
}

export interface Opportunity {
  buyDex: string;
  sellDex: string;
  buyPrice: string;
  sellPrice: string;
  spreadPct: number;
  estimatedProfit: string;
  liquidityUSD: number;
}

export function tokenMatches(symbol: string, target: string): boolean {
  const s = symbol.toUpperCase();
  const t = target.toUpperCase();
  if (s === t) return true;
  if (t === 'ETH' && (s === 'WETH' || s === 'ETH')) return true;
  if (t === 'BTC' && (s === 'WBTC' || s === 'BTC')) return true;
  return false;
}

export function parsePair(pair: string): [string, string] | null {
  const trimmed = pair.trim();
  if (!trimmed) return null;

  const parts = trimmed.split('/');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return [parts[0].trim(), parts[1].trim()];
  }

  const dashParts = trimmed.split('-');
  if (dashParts.length === 2 && dashParts[0] && dashParts[1]) {
    return [dashParts[0].trim(), dashParts[1].trim()];
  }

  return null;
}

export function computeOpportunities(
  pairs: DexPair[],
  [baseSymbol, quoteSymbol]: [string, string],
): Opportunity[] {
  const seen = new Set<string>();
  const filtered: DexPair[] = [];

  for (const p of pairs) {
    const dexPairKey = `${p.dexId}:${p.pairAddress}`;
    if (seen.has(dexPairKey)) continue;
    seen.add(dexPairKey);

    if (!tokenMatches(p.baseToken.symbol, baseSymbol)) continue;
    if (!tokenMatches(p.quoteToken.symbol, quoteSymbol)) continue;

    const liq = p.liquidity?.usd ?? 0;
    if (liq < MIN_LIQUIDITY_USD) continue;

    const price = parseFloat(p.priceUsd);
    if (isNaN(price) || price <= 0) continue;

    filtered.push(p);
  }

  if (filtered.length < 2) return [];

  filtered.sort((a, b) => parseFloat(a.priceUsd) - parseFloat(b.priceUsd));

  const opportunities: Opportunity[] = [];

  for (let i = 0; i < filtered.length - 1 && opportunities.length < MAX_OPPORTUNITIES; i++) {
    for (let j = filtered.length - 1; j > i && opportunities.length < MAX_OPPORTUNITIES; j--) {
      const buy = filtered[i];
      const sell = filtered[j];

      const buyPrice = parseFloat(buy.priceUsd);
      const sellPrice = parseFloat(sell.priceUsd);

      if (sellPrice <= buyPrice) continue;

      const spreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;
      const profit = sellPrice - buyPrice;

      if (spreadPct <= 0.001) continue;

      opportunities.push({
        buyDex: buy.dexId,
        sellDex: sell.dexId,
        buyPrice: buyPrice.toFixed(2),
        sellPrice: sellPrice.toFixed(2),
        spreadPct: Math.round(spreadPct * 1000) / 1000,
        estimatedProfit: profit.toFixed(2),
        liquidityUSD: buy.liquidity.usd,
      });
    }
  }

  opportunities.sort((a, b) => b.spreadPct - a.spreadPct);

  return opportunities.slice(0, MAX_OPPORTUNITIES);
}
