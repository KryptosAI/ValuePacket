import type { Address } from 'viem';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export {
  SERVICE_REGISTRY_ABI,
  PAYMENT_CHANNEL_ABI,
  SPENDING_POLICY_ABI,
} from '@valuepacket/sdk';

export const SERVICE_REGISTRY_ADDRESS_DEFAULT: Address =
  '0x0000000000000000000000000000000000000000' as Address;

export const PAYMENT_CHANNEL_ADDRESS_DEFAULT: Address =
  '0x0000000000000000000000000000000000000000' as Address;

export const SPENDING_POLICY_ADDRESS_DEFAULT: Address =
  '0x0000000000000000000000000000000000000000' as Address;

export const USDC_BASE_SEPOLIA: Address =
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

export const mintAbi = [
  {
    type: 'function',
    name: 'mint',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

export const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address', internalType: 'address' },
      { name: 'amount', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'allowance',
    inputs: [
      { name: 'owner', type: 'address', internalType: 'address' },
      { name: 'spender', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [{ name: '', type: 'uint8', internalType: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'symbol',
    inputs: [],
    outputs: [{ name: '', type: 'string', internalType: 'string' }],
    stateMutability: 'view',
  },
] as const;

export const mockUsdcAbi = [
  ...erc20Abi,
  {
    type: 'function',
    name: 'mint',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

export async function getLocalDeploymentAddresses(): Promise<{
  mockUSDC: Address;
  serviceRegistry: Address;
  paymentChannel: Address;
  spendingPolicy: Address;
} | null> {
  const searchPaths = [
    resolve(process.cwd(), 'contracts', 'deployments', 'local.json'),
    resolve(process.cwd(), '..', 'contracts', 'deployments', 'local.json'),
    resolve(process.cwd(), 'deployments', 'local.json'),
  ];
  for (const deploymentPath of searchPaths) {
    try {
      const raw = readFileSync(deploymentPath, 'utf-8');
      const data = JSON.parse(raw);
      return {
        mockUSDC: (data.mockUSDC || data.usdcToken || data.USDC) as Address,
        serviceRegistry: data.serviceRegistry as Address,
        paymentChannel: data.paymentChannel as Address,
        spendingPolicy: data.spendingPolicy as Address,
      };
    } catch {
      continue;
    }
  }
  return null;
}
