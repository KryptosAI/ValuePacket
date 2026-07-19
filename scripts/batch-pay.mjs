/**
 * batch-pay.mjs — Open $0.25 USDC payment channels to early ValuePacket participants.
 *
 * Usage:
 *   PRIVATE_KEY=0x... node scripts/batch-pay.mjs recipients.json
 *
 * recipients.json: [{"address": "0x...", "handle": "@alice"}]
 *
 * Each recipient gets:
 *   1. A $0.25 USDC payment channel opened to their wallet (7-day expiry)
 *   2. An EAS attestation rating them as an "early ValuePacket participant"
 *
 * They claim by closing the channel:
 *   npx valuepacket close-channel <channelId> --private-key <their-key>
 *
 * Unclaimed channels are refundable by the payer after expiry.
 */

import { createPublicClient, createWalletClient, http, parseAbi, encodeAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const RPC = process.env.RPC_URL || 'https://sepolia.base.org';
const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error('Set PRIVATE_KEY env var'); process.exit(1); }

// Deployed Base Sepolia addresses
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const CHANNEL = '0x9c350ae4D2e8aE380185d3AC95b56fedF98837C3';
const REPUTATION = '0x014d6681978A43E0ceCF7BF6474095f7Fa5905f3';
const REGISTRY = '0x32487f8a8B54A8E8efBAb0c72De7b34239952180';
const ZERO = '0x0000000000000000000000000000000000000000';
const AMOUNT = 250_000n; // $0.25 USDC (6 decimals)
const EXPIRY_SECONDS = 7 * 24 * 3600; // 7 days

const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

const channelAbi = parseAbi([
  'function openChannel(address payee, address token, uint256 deposit, uint32 expiresAt, address policy, bytes metadata) returns (uint256)',
  'function getChannelCount() view returns (uint256)',
  'function closeChannel(uint256 channelId, uint256 spent, bytes signature)',
]);

const reputationAbi = parseAbi([
  'function rateService(address provider, bytes32 channelId, uint8 score, string comment) returns (bytes32)',
]);

const registryAbi = parseAbi([
  'function register(string metadataURI, uint256 pricePerRequest, uint32 maxResponseMs) returns (bytes32)',
]);

async function main() {
  const recipients = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
  if (!Array.isArray(recipients) || recipients.length === 0) {
    console.error('Usage: node batch-pay.mjs recipients.json');
    process.exit(1);
  }

  const account = privateKeyToAccount(PK);
  const chain = { id: 84532, name: 'Base Sepolia', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
  const pc = createPublicClient({ chain, transport: http(RPC) });
  const wc = createWalletClient({ account, chain, transport: http(RPC) });

  const payer = account.address;

  // ── Check balances ──
  const usdcBalance = await pc.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [payer] });
  const totalNeeded = BigInt(recipients.length) * AMOUNT;
  console.log(`Payer: ${payer}`);
  console.log(`USDC balance: ${Number(usdcBalance) / 1e6} USDC`);
  console.log(`Recipients: ${recipients.length} | Total needed: ${Number(totalNeeded) / 1e6} USDC`);
  if (usdcBalance < totalNeeded) {
    console.error(`Insufficient USDC. Need ${Number(totalNeeded - usdcBalance) / 1e6} more.`);
    console.error('Get testnet USDC: https://faucet.circle.com');
    process.exit(1);
  }

  // ── Approve USDC for PaymentChannel ──
  const allowance = await pc.readContract({ address: USDC, abi: erc20Abi, functionName: 'allowance', args: [payer, CHANNEL] });
  if (allowance < totalNeeded) {
    console.log(`Approving ${Number(totalNeeded) / 1e6} USDC for PaymentChannel...`);
    const atx = await wc.writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [CHANNEL, totalNeeded], chain, account });
    await pc.waitForTransactionReceipt({ hash: atx });
    console.log(`  approved: ${atx}`);
  }

  // ── Register as a service (so we appear in the registry) ──
  const metaURI = 'https://raw.githubusercontent.com/KryptosAI/ValuePacket/main/public/batch-payer-metadata.json';
  let serviceId;
  try {
    const stx = await wc.writeContract({ address: REGISTRY, abi: registryAbi, functionName: 'register', args: [metaURI, 0n, 0], chain, account });
    const receipt = await pc.waitForTransactionReceipt({ hash: stx });
    console.log(`Service registered: ${stx}`);
  } catch (e) {
    // already registered, fine
  }

  console.log('');

  const expiresAt = Math.floor(Date.now() / 1000) + EXPIRY_SECONDS;
  const startCount = await pc.readContract({ address: CHANNEL, abi: channelAbi, functionName: 'getChannelCount' });
  let nextChannelId = startCount + 1n;
  const results = [];

  for (const { address, handle } of recipients) {
    try {
      const tx = await wc.writeContract({
        address: CHANNEL,
        abi: channelAbi,
        functionName: 'openChannel',
        args: [address, USDC, AMOUNT, expiresAt, ZERO, '0x'],
        chain,
        account,
      });
      await pc.waitForTransactionReceipt({ hash: tx });
      const channelId = nextChannelId++;

      // ── Rate them on AgentReputation (creates EAS attestation) ──
      const channelIdBytes32 = `0x${channelId.toString(16).padStart(64, '0')}`;
      try {
        await wc.writeContract({
          address: REPUTATION,
          abi: reputationAbi,
          functionName: 'rateService',
          args: [address, channelIdBytes32, 10, `ValuePacket early participant — ${handle}`],
          chain,
          account,
        });
      } catch (e) {
        // non-critical
      }

      results.push({ address, handle, channelId: Number(channelId), tx });
      console.log(`  #${channelId} → ${handle.padEnd(16)} ${address.slice(0, 10)}…  ${tx.slice(0, 10)}…`);
    } catch (e) {
      console.error(`  FAIL ${handle}: ${e.message?.slice(0, 80)}`);
    }

    if (results.length % 5 === 0 && results.length < recipients.length) {
      console.log(`  … ${results.length}/${recipients.length}, pausing 2s for RPC rate limit`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\nDone. ${results.length}/${recipients.length} channels opened.`);
  console.log('Channels expire in 7 days. Each recipient can claim by closing their channel.');
  console.log('');
  const ids = results.map(r => String(r.channelId)).join(' ');
  console.log(`Refund command (after ${new Date((expiresAt + 60) * 1000).toISOString()}):`);
  console.log(`  for id in ${ids}; do`);
  console.log('    cast send 0x9c350ae4D2e8aE380185d3AC95b56fedF98837C3 "refundChannel(uint256)" $id \\');
  console.log('      --private-key $PK --rpc-url https://sepolia.base.org');
  console.log('  done');
}

main().catch(e => { console.error(e); process.exit(1); });
