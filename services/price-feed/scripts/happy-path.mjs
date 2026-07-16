/**
 * ValuePacket Price Feed — Happy Path E2E Harness
 * Proves full paid-request flow: approve → openChannel → paid requests
 * → replay rejection → wrong-signer rejection → EIP-712 settlement.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, createPublicClient, http, parseAbi, keccak256, toHex } from 'viem';

const RPC = process.env.RPC_URL || 'http://localhost:8545';
const PAYER_PK = process.env.PRIVATE_KEY;
const PAYEE_PK = process.env.PAYEE_PRIVATE_KEY;
const CHANNEL_ADDR = process.env.PAYMENT_CHANNEL_ADDRESS;
const USDC_ADDR = process.env.USDC_ADDRESS;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const DEPOSIT = 2_000_000n; // 2 USDC

if (!PAYER_PK || !PAYEE_PK || !CHANNEL_ADDR || !USDC_ADDR) {
  console.error('Missing env vars: PRIVATE_KEY, PAYEE_PRIVATE_KEY, PAYMENT_CHANNEL_ADDRESS, USDC_ADDRESS');
  process.exit(1);
}

const transport = http(RPC);
const bootstrapClient = createPublicClient({ transport });
const chainId = await bootstrapClient.getChainId();
const chain = { id: chainId, name: `Chain ${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const publicClient = createPublicClient({ chain, transport });

const payerAccount = privateKeyToAccount(PAYER_PK);
const payeeAccount = privateKeyToAccount(PAYEE_PK);
const payerWallet = createWalletClient({ account: payerAccount, chain, transport });
const payeeWallet = createWalletClient({ account: payeeAccount, chain, transport });

const CHANNEL_CLOSE_TYPE = {
  ChannelClose: [{ name: 'channelId', type: 'uint256' }, { name: 'spent', type: 'uint256' }],
};
const PAYMENT_PROOF_TYPE = {
  PaymentProof: [
    { name: 'channelId', type: 'uint256' },
    { name: 'cumulativeSpent', type: 'uint256' },
    { name: 'requestHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
  ],
};
const DOMAIN = { name: 'ValuePacket', version: '1', chainId, verifyingContract: CHANNEL_ADDR };

const PChAbi = parseAbi([
  'function openChannel(address payee,address token,uint256 deposit,uint32 expiresAt,address policy,bytes metadata) returns (uint256)',
  'function closeChannel(uint256 channelId,uint256 spent,bytes signature)',
  'function getChannel(uint256 channelId) view returns ((address payer,address payee,address token,uint256 deposit,uint256 spent,uint32 openedAt,uint32 expiresAt,address policy,bytes metadata,uint8 status))',
  'function getChannelCount() view returns (uint256)',
  'event ChannelOpened(uint256 indexed channelId,address indexed payer,address indexed payee,address token,uint256 deposit,uint32 expiresAt)',
  'event ChannelClosed(uint256 indexed channelId,uint256 spent)',
]);
const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]);

function fmtHex(addr) { return `${addr.slice(0,6)}...${addr.slice(-4)}`; }

const results = [];

async function check(step, expected, fn) {
  try {
    const actual = await fn();
    const pass = typeof expected === 'function'
      ? expected(actual)
      : actual === expected
        || ((typeof actual === 'bigint' || typeof expected === 'bigint')
          ? String(actual) === String(expected)
          : JSON.stringify(actual) === JSON.stringify(expected));
    results.push({ step, expected: typeof expected === 'function' ? 'custom' : String(expected), actual: String(actual).slice(0,80), pass });
    if (!pass) { console.error(`  FAIL step ${step}: expected ${expected}, got ${actual}`); process.exit(1); }
    return actual;
  } catch (e) {
    results.push({ step, expected: String(expected).slice(0,80), actual: `ERROR: ${e.message}`, pass: false });
    console.error(`  FAIL step ${step}: ${e.message}`);
    process.exit(1);
  }
}

console.log('╔═══════════════════════════════════════╗');
console.log('║  ValuePacket Happy-Path E2E Harness  ║');
console.log('╚═══════════════════════════════════════╝');
console.log(`  Payer:    ${fmtHex(payerAccount.address)}`);
console.log(`  Payee:    ${fmtHex(payeeAccount.address)}`);
console.log(`  Channel:  ${fmtHex(CHANNEL_ADDR)}`);
console.log(`  USDC:     ${fmtHex(USDC_ADDR)}`);
console.log(`  Chain ID: ${chainId}`);
console.log('');

const payerBalanceBefore = await publicClient.readContract({ address: USDC_ADDR, abi: erc20Abi, functionName: 'balanceOf', args: [payerAccount.address] });
const payeeBalanceBefore = await publicClient.readContract({ address: USDC_ADDR, abi: erc20Abi, functionName: 'balanceOf', args: [payeeAccount.address] });

// Step 1: approve
console.log('[1/8] approve USDC spend...');
const approveTx = await payerWallet.writeContract({
  address: USDC_ADDR, abi: erc20Abi, functionName: 'approve', args: [CHANNEL_ADDR, DEPOSIT], chain, account: payerAccount,
});
await publicClient.waitForTransactionReceipt({ hash: approveTx });
await check('1-approve', h => h.startsWith('0x') && h.length === 66, () => approveTx);
let observedAllowance = 0n;
for (let attempt = 0; attempt < 12; attempt += 1) {
  observedAllowance = await publicClient.readContract({ address: USDC_ADDR, abi: erc20Abi, functionName: 'allowance', args: [payerAccount.address, CHANNEL_ADDR] });
  if (observedAllowance >= DEPOSIT) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
await check('1-allowance-observed', value => value >= DEPOSIT, () => observedAllowance);

// Step 2: openChannel
console.log('[2/8] openChannel...');
const countBefore = await publicClient.readContract({ address: CHANNEL_ADDR, abi: PChAbi, functionName: 'getChannelCount' });
const expiresAt = Math.floor(Date.now() / 1000) + 3600;
const openHash = await payerWallet.writeContract({
  address: CHANNEL_ADDR, abi: PChAbi, functionName: 'openChannel',
  args: [payeeAccount.address, USDC_ADDR, DEPOSIT, expiresAt, '0x0000000000000000000000000000000000000000', '0x'],
  chain, account: payerAccount,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash: openHash });
const channelIdLog = receipt.logs.find(l => l.address.toLowerCase() === CHANNEL_ADDR.toLowerCase());
const channelId = channelIdLog ? BigInt(channelIdLog.topics[1]) : 0n;

let count = countBefore;
for (let attempt = 0; attempt < 12; attempt += 1) {
  count = await publicClient.readContract({ address: CHANNEL_ADDR, abi: PChAbi, functionName: 'getChannelCount' });
  if (count > countBefore) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
await check('2-openChannel-count', cnt => cnt > countBefore, () => count);
console.log(`  channelId=${channelId}, count=${count}`);

// Step 3: first paid request
console.log('[3/8] POST /price/eth-usdc (request 1)...');
const body1 = { pair: 'eth-usdc' };
const nonce1 = 1n; const spent1 = 1000n;
const hash1 = keccak256(toHex(JSON.stringify(body1)));
const sig1 = await payerWallet.signTypedData({
  account: payerAccount, domain: DOMAIN, types: PAYMENT_PROOF_TYPE, primaryType: 'PaymentProof',
  message: { channelId, cumulativeSpent: spent1, requestHash: hash1, nonce: nonce1 },
});
const res1 = await fetch(`${BASE_URL}/price/eth-usdc`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Channel-Id': channelId.toString(), 'X-Cumulative-Spent': spent1.toString(), 'X-Payment-Proof': sig1, 'X-Request-Nonce': nonce1.toString(), 'X-Request-Hash': hash1 },
  body: JSON.stringify(body1),
});
const price1 = await res1.json();
await check('3-first-request-200', 200, () => res1.status);
await check('3-first-request-price', p => typeof p.price === 'number', () => price1);
console.log(`  ${res1.status} — ${JSON.stringify(price1)}`);

// Step 4: second paid request
console.log('[4/8] POST /price/eth-usdc (request 2)...');
const body2 = { pair: 'eth-usdc' };
const nonce2 = 2n; const spent2 = 2000n;
const hash2 = keccak256(toHex(JSON.stringify(body2)));
const sig2 = await payerWallet.signTypedData({
  account: payerAccount, domain: DOMAIN, types: PAYMENT_PROOF_TYPE, primaryType: 'PaymentProof',
  message: { channelId, cumulativeSpent: spent2, requestHash: hash2, nonce: nonce2 },
});
const res2 = await fetch(`${BASE_URL}/price/eth-usdc`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Channel-Id': channelId.toString(), 'X-Cumulative-Spent': spent2.toString(), 'X-Payment-Proof': sig2, 'X-Request-Nonce': nonce2.toString(), 'X-Request-Hash': hash2 },
  body: JSON.stringify(body2),
});
const price2 = await res2.json();
await check('4-second-request-200', 200, () => res2.status);
await check('4-second-request-price', p => typeof p.price === 'number', () => price2);
console.log(`  ${res2.status} — ${JSON.stringify(price2)}`);

// Step 5: replay rejection (same nonce as #2)
console.log('[5/8] POST /price/eth-usdc (replay — expect 409)...');
const res5 = await fetch(`${BASE_URL}/price/eth-usdc`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Channel-Id': channelId.toString(), 'X-Cumulative-Spent': spent2.toString(), 'X-Payment-Proof': sig2, 'X-Request-Nonce': nonce2.toString(), 'X-Request-Hash': hash2 },
  body: JSON.stringify(body2),
});
await check('5-replay-409', 409, () => res5.status);
console.log(`  ${res5.status} — replay correctly rejected`);

// Step 6: wrong signer (random key)
console.log('[6/8] POST /price/eth-usdc (wrong signer — expect 401)...');
const randomKey = '0x' + '1'.repeat(64);
const badSigner = privateKeyToAccount(randomKey);
const badWallet = createWalletClient({ account: badSigner, chain, transport });
const body6 = { pair: 'eth-usdc' };
const hash6 = keccak256(toHex(JSON.stringify(body6)));
const sig6 = await badWallet.signTypedData({
  account: badSigner, domain: DOMAIN, types: PAYMENT_PROOF_TYPE, primaryType: 'PaymentProof',
  message: { channelId, cumulativeSpent: 3000n, requestHash: hash6, nonce: 3n },
});
const res6 = await fetch(`${BASE_URL}/price/eth-usdc`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Channel-Id': channelId.toString(), 'X-Cumulative-Spent': '3000', 'X-Payment-Proof': sig6, 'X-Request-Nonce': '3', 'X-Request-Hash': hash6 },
  body: JSON.stringify(body6),
});
await check('6-wrong-signer-401', 401, () => res6.status);
console.log(`  ${res6.status} — wrong signer correctly rejected`);

// Step 7: settlement — closeChannel from payee with payer's signature
console.log('[7/8] closeChannel (settlement)...');
const closeSig = await payerWallet.signTypedData({
  account: payerAccount, domain: DOMAIN, types: CHANNEL_CLOSE_TYPE, primaryType: 'ChannelClose',
  message: { channelId, spent: spent2 },
});
const closeHash = await payeeWallet.writeContract({
  address: CHANNEL_ADDR, abi: PChAbi, functionName: 'closeChannel', args: [channelId, spent2, closeSig],
  chain, account: payeeAccount,
});
await publicClient.waitForTransactionReceipt({ hash: closeHash });

let final;
for (let attempt = 0; attempt < 12; attempt += 1) {
  final = await publicClient.readContract({ address: CHANNEL_ADDR, abi: PChAbi, functionName: 'getChannel', args: [channelId] });
  const observedSpent = final.spent !== undefined ? final.spent : final[4];
  const observedStatus = final.status !== undefined ? final.status : final[9];
  if (BigInt(observedSpent) === spent2 && Number(observedStatus) === 1) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
const spent_onchain = final.spent !== undefined ? final.spent : final[4];
const payerBalanceAfter = await publicClient.readContract({ address: USDC_ADDR, abi: erc20Abi, functionName: 'balanceOf', args: [payerAccount.address] });
const payeeBalanceAfter = await publicClient.readContract({ address: USDC_ADDR, abi: erc20Abi, functionName: 'balanceOf', args: [payeeAccount.address] });
await check('7-settlement-spent', spent2, () => BigInt(spent_onchain));
await check('7-settlement-payee-paid', spent2, () => payeeBalanceAfter - payeeBalanceBefore);
await check('7-settlement-payer-refunded', payerBalanceBefore - spent2, () => payerBalanceAfter);
console.log(`  settled: spent=${spent_onchain.toString()}, status=Settled`);

// Step 8: verify on-chain state
console.log('[8/8] final state...');
const ch = final;
const chStatus = ch.status !== undefined ? ch.status : ch[9];
await check('8-status-settled', 1, () => Number(chStatus));
console.log('');

// Summary
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;
console.log('═══════════════════════════════════════');
console.log(`  Results: ${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
console.log('═══════════════════════════════════════');
results.forEach(r => console.log(`  ${r.pass ? '✓' : '✗'} ${r.step}: ${r.actual}`));
console.log('');

if (failed > 0) process.exit(1);
console.log('All pass criteria met.');
