import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Account,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { mockUsdcAbi } from './contracts.js';

export { baseSepolia };

export interface CliWallet {
  address: Address;
  privateKey: Hash;
  account: ReturnType<typeof privateKeyToAccount>;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

const ANVIL_DEPLOYER_KEY: Hash =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const ANVIL_RPC_URL = 'http://127.0.0.1:8545';

export const ANVIL_CHAIN: Chain = {
  id: 31337,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [ANVIL_RPC_URL] },
  },
} as const satisfies Chain;

export function log(msg: string): void {
  const ts = new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  process.stdout.write(`[${ts}] ${msg}\n`);
}

export function formatAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function formatUsdc(amount: bigint, decimals: number = 6): string {
  const whole = amount / BigInt(10 ** decimals);
  const frac = amount % BigInt(10 ** decimals);
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  if (fracStr === '') return `$${whole.toString()}.00`;
  return `$${whole.toString()}.${fracStr.padEnd(2, '0')}`;
}

export function usdcToWei(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000));
}

export function weiToUsdc(amount: bigint): number {
  return Number(amount) / 1_000_000;
}

export function createCliWallet(
  privateKey: Hash,
  rpcUrl: string,
  chain: Chain = baseSepolia,
): CliWallet {
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  }) as PublicClient;
  const walletClient = createWalletClient({
    chain,
    transport: http(rpcUrl),
    account,
  });
  return {
    address: account.address,
    privateKey,
    account,
    publicClient,
    walletClient,
  };
}

export function generateWallet(rpcUrl: string, chain: Chain = baseSepolia): CliWallet {
  const pk = generatePrivateKey();
  return createCliWallet(pk, rpcUrl, chain);
}

export async function checkBalances(
  wallet: CliWallet,
  usdcAddress: Address,
): Promise<{ eth: bigint; usdc: bigint }> {
  const [eth, usdc] = await Promise.all([
    wallet.publicClient.getBalance({ address: wallet.address }),
    wallet.publicClient.readContract({
      address: usdcAddress,
      abi: [
        {
          type: 'function',
          name: 'balanceOf',
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
          stateMutability: 'view',
        },
      ],
      functionName: 'balanceOf',
      args: [wallet.address],
    }),
  ]);
  return { eth, usdc: usdc as unknown as bigint };
}

export function getDefaultChain(chainId?: number): Chain {
  if (chainId === 84532 || chainId === undefined) return baseSepolia;
  return baseSepolia;
}

export const ZERO_ADDRESS: Address =
  '0x0000000000000000000000000000000000000000';

export const FAUCET_URLS = {
  eth: 'https://www.alchemy.com/faucets/base-sepolia',
  ethAlt: 'https://base-sepolia-faucet.com',
  usdc: 'https://faucet.circle.com',
} as const;

export function truncate(str: string, maxLen: number = 80): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

export function getAnvilDeployer(): WalletClient<Transport, Chain, Account> {
  const account = privateKeyToAccount(ANVIL_DEPLOYER_KEY);
  return createWalletClient({
    chain: ANVIL_CHAIN,
    transport: http(ANVIL_RPC_URL),
    account,
  });
}

export async function mintMockUSDC(
  tokenAddress: Address,
  to: Address,
  amount: bigint,
  rpcUrl: string = ANVIL_RPC_URL,
): Promise<Hash> {
  const account = privateKeyToAccount(ANVIL_DEPLOYER_KEY);
  const walletClient = createWalletClient({
    chain: ANVIL_CHAIN,
    transport: http(rpcUrl),
    account,
  });
  return walletClient.writeContract({
    address: tokenAddress,
    abi: mockUsdcAbi,
    functionName: 'mint',
    args: [to, amount],
    chain: ANVIL_CHAIN,
  } as any);
}

export function isLocalChain(chainId: number): boolean {
  return chainId === 31337 || chainId === 1337;
}
