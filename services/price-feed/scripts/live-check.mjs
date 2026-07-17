import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createWalletClient, http, keccak256, toHex } from 'viem';
import { baseSepolia } from 'viem/chains';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const CHANNEL = process.env.PAYMENT_CHANNEL_ADDRESS || '0x9c350ae4D2e8aE380185d3AC95b56fedF98837C3';
const CHAIN_ID = 84532;

const PAYMENT_PROOF_TYPE = {
  PaymentProof: [
    { name: 'channelId', type: 'uint256' },
    { name: 'cumulativeSpent', type: 'uint256' },
    { name: 'requestHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
  ],
};

const account = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() });

const channelId = 999999n;
const cumulativeSpent = 1000n;
const nonce = 1n;
const body = { query: 'price' };
const requestHash = keccak256(toHex(JSON.stringify(body)));

const signature = await wallet.signTypedData({
  account,
  domain: { name: 'ValuePacket', version: '1', chainId: CHAIN_ID, verifyingContract: CHANNEL },
  types: PAYMENT_PROOF_TYPE,
  primaryType: 'PaymentProof',
  message: { channelId, cumulativeSpent, requestHash, nonce },
});

const res = await fetch(`${BASE}/price/eth-usdc`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Channel-Id': channelId.toString(),
    'X-Cumulative-Spent': cumulativeSpent.toString(),
    'X-Payment-Proof': signature,
    'X-Request-Nonce': nonce.toString(),
    'X-Request-Hash': requestHash,
  },
  body: JSON.stringify(body),
});

const text = await res.text();
console.log(`signer:      ${account.address}`);
console.log(`status:      ${res.status}`);
console.log(`response:    ${text}`);
console.log(
  `\nverdict:     ${
    /not found|channelnotfound|reverted|channel 999999/i.test(text)
      ? 'PASS — service queried the live base-sepolia contract (channel absent as expected)'
      : 'CHECK — inspect response above'
  }`,
);
