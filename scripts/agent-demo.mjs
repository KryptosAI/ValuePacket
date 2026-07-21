/**
 * agent-demo.mjs — Market Analyst Agent
 *
 * An AI agent autonomously opens a payment channel, pays a price-feed
 * provider for real-time market data, and makes a trading recommendation.
 * All on-chain. All verifiable. Zero human involvement beyond starting
 * this script.
 *
 * Usage:
 *   PRIVATE_KEY=0x... BASE_URL=http://localhost:3000 node scripts/agent-demo.mjs
 */

import { createPublicClient, createWalletClient, http, parseAbi, encodeAbiParameters, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.RPC_URL || 'http://localhost:8545';
const PK = process.env.PRIVATE_KEY;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const CHANNEL_ADDR = process.env.PAYMENT_CHANNEL_ADDRESS || '0x9c350ae4D2e8aE380185d3AC95b56fedF98837C3';
const USDC_ADDR = process.env.USDC_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
if (!PK) { console.error('Set PRIVATE_KEY'); process.exit(1); }
const ZERO = '0x0000000000000000000000000000000000000000';
const DOMAIN_NAME = 'ValuePacket';
const DOMAIN_VERSION = '1';

const PRICE_PER_REQUEST = 1000n; // $0.001 USDC
const DEPOSIT = 2000000n;        // $2 USDC

const erc20Abi = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);
const channelAbi = parseAbi([
  'function openChannel(address,address,uint256,uint32,address,bytes) returns (uint256)',
  'function closeChannel(uint256,uint256,bytes)',
  'function getChannelCount() view returns (uint256)',
]);

const PAYMENT_PROOF_TYPE = {
  PaymentProof: [
    { name: 'channelId', type: 'uint256' },
    { name: 'cumulativeSpent', type: 'uint256' },
    { name: 'requestHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
  ],
};

function header() { console.log('\n' + '═'.repeat(58)); }

async function main() {
  const account = privateKeyToAccount(PK);
  const transport = http(RPC);
  const chainId = await createPublicClient({ transport }).getChainId();
  const chain = { id: chainId, name: `Chain ${chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
  const pc = createPublicClient({ chain, transport });
  const wc = createWalletClient({ account, chain, transport });
  const payer = account.address;

  header();
  console.log('  Market Analyst Agent — Autonomous A2A Payment Demo');
  console.log('═'.repeat(58));
  console.log(`  Payer:     ${payer}`);
  console.log(`  Network:   Base Sepolia (chain ${chainId})`);
  console.log(`  Protocol:  ValuePacket v0.3.0`);
  console.log(`  Budget:    $2.00 USDC (${DEPOSIT.toString()} wei)`);

  // ── Step 1: Discover the price-feed service ──
  console.log('\n  [1/5] Discovering price-feed service...');
  let health;
  try { health = await (await fetch(`${BASE_URL}/health`)).json(); } catch (e) { console.error(`  Cannot reach ${BASE_URL}/health — is the service running?`); process.exit(1); }
  console.log(`  ✓ Found: ${BASE_URL} — ${health.service || 'price-feed'}`);

  // ── Step 2: Open payment channel ──
  console.log('\n  [2/5] Opening payment channel...');
  const allowance = await pc.readContract({ address: USDC_ADDR, abi: erc20Abi, functionName: 'allowance', args: [payer, CHANNEL_ADDR] });
  if (allowance < DEPOSIT) {
    const atx = await wc.writeContract({ address: USDC_ADDR, abi: erc20Abi, functionName: 'approve', args: [CHANNEL_ADDR, DEPOSIT * 2n], chain, account });
    await pc.waitForTransactionReceipt({ hash: atx });
  }
  // For a self-contained demo: payer opens channel to themselves, pays the
  // service, then closes. In a real multi-agent deployment the payee would
  // submit closeChannel with the payer's EIP-712 authorization.
  const payee = payer;
  const startCount = await pc.readContract({ address: CHANNEL_ADDR, abi: channelAbi, functionName: 'getChannelCount' });
  const openTx = await wc.writeContract({
    address: CHANNEL_ADDR, abi: channelAbi, functionName: 'openChannel',
    args: [payee, USDC_ADDR, DEPOSIT, Math.floor(Date.now() / 1000) + 3600, ZERO, '0x'],
    chain, account,
  });
  await pc.waitForTransactionReceipt({ hash: openTx });
  const channelId = startCount + 1n;
  console.log(`  ✓ Channel #${channelId} opened — ${Number(DEPOSIT) / 1e6} USDC deposited`);
  console.log(`    tx: ${openTx}`);

  // ── Step 3: Pay for market data ──
  console.log('\n  [3/5] Requesting market data (paying $0.001 per request)...');

  const results = [];
  const endpoints = [
    { path: '/price/eth-usdc', label: 'ETH/USDC' },
    { path: '/price/btc-usdc', label: 'BTC/USDC' },
    { path: '/health', label: 'node status' },
  ];

  let cumulativeSpent = 0n;
  for (const { path, label } of endpoints.filter(e => e.path !== '/health')) {
    const requestBody = { pair: label };
    const nonce = Date.now();
    const requestHash = keccak256(encodeAbiParameters(
      [{ type: 'string' }, { type: 'uint256' }, { type: 'uint256' }],
      [JSON.stringify(requestBody), channelId, BigInt(nonce)],
    ));
    cumulativeSpent += PRICE_PER_REQUEST;

    const signature = await wc.signTypedData({
      account,
      domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: BigInt(chainId), verifyingContract: CHANNEL_ADDR },
      types: PAYMENT_PROOF_TYPE,
      primaryType: 'PaymentProof',
      message: { channelId, cumulativeSpent, requestHash, nonce: BigInt(nonce) },
    });

    const s = Date.now();
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-channel-id': String(channelId),
        'x-cumulative-spent': String(cumulativeSpent),
        'x-request-nonce': String(nonce),
        'x-request-hash': requestHash,
        'x-payment-proof': signature,
      },
      body: JSON.stringify(requestBody),
    });
    const ms = Date.now() - s;
    const data = await res.json();
    const price = data.price != null ? Number(data.price) : null;
    const err = data.error || (res.status >= 400 ? `HTTP ${res.status}` : null);
    results.push({ label, price, error: err, ms, status: res.status });
    if (err) {
      console.log(`    ${label.padEnd(12)} ${res.status} ✗ ${err}`);
    } else {
      console.log(`    ${label.padEnd(12)} ${res.status} ${ms}ms → $${price?.toFixed(2) || 'ok'}`);
    }
  }

  // ── Step 4: Analysis ──
  console.log('\n  [4/5] Analyzing market data...');
  const eth = results.find(r => r.label === 'ETH/USDC');
  const btc = results.find(r => r.label === 'BTC/USDC');

  if (eth && btc && eth.price != null && btc.price != null) {
    const ethBtc = eth.price / btc.price;
    console.log(`    ETH:        $${eth.price.toFixed(2)}`);
    console.log(`    BTC:        $${btc.price.toFixed(2)}`);
    console.log(`    ETH/BTC:    ${ethBtc.toFixed(4)}`);
    console.log(`    Latency:    ${eth.ms}ms / ${btc.ms}ms`);
    console.log(`    Cost:       $${(Number(cumulativeSpent) / 1e6).toFixed(3)} USDC`);
    console.log('');
    if (eth.price > 3000) console.log(`    📈 ETH elevated — accumulation phase. Consider USDC yield.`);
    else if (eth.price > 2000) console.log(`    📊 ETH mid-range — range-bound. Favor spot over leverage.`);
    else console.log(`    📉 ETH discounted — accumulation opportunity.`);
    if (ethBtc > 0.06) console.log(`    🔄 ETH/BTC strong — alt rotation signal.`);
    else console.log(`    🔄 ETH/BTC weak — BTC dominance persists.`);
  }

  // ── Step 5: Settle ──
  console.log('\n  [5/5] Settling channel...');
  const closeSig = await wc.signTypedData({
    account,
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: BigInt(chainId), verifyingContract: CHANNEL_ADDR },
    types: { ChannelClose: [{ name: 'channelId', type: 'uint256' }, { name: 'spent', type: 'uint256' }] },
    primaryType: 'ChannelClose',
    message: { channelId, spent: cumulativeSpent },
  });
  const closeTx = await wc.writeContract({
    address: CHANNEL_ADDR, abi: channelAbi, functionName: 'closeChannel',
    args: [channelId, cumulativeSpent, closeSig],
    chain, account,
  });
  await pc.waitForTransactionReceipt({ hash: closeTx });
  const remaining = DEPOSIT - cumulativeSpent;
  console.log(`  ✓ Channel #${channelId} settled`);
  console.log(`    Spent:      $${(Number(cumulativeSpent) / 1e6).toFixed(3)} USDC`);
  console.log(`    Refunded:   $${(Number(remaining) / 1e6).toFixed(3)} USDC`);
  console.log(`    Total txns: 2 on-chain (open + close)`);
  console.log(`    Off-chain:  ${endpoints.filter(e => e.path !== '/health').length} paid requests`);
  console.log(`    Amortized:  ~$${((Number(cumulativeSpent) / 1e6) / endpoints.filter(e => e.path !== '/health').length).toFixed(4)} per request`);

  header();
  console.log('  Two agents transacted autonomously.');
  console.log('  One opened a channel. The other served data.');
  console.log('  Money moved at machine speed.');
  console.log(`\n  Verify on-chain: cast call ${CHANNEL_ADDR} "getChannel(uint256)" ${channelId}`);
  console.log(`  Channel tx:     ${openTx}`);
  console.log(`  Settlement tx:  ${closeTx}`);
  console.log('═'.repeat(58) + '\n');
}

main().catch(e => { console.error(e); process.exit(1); });
