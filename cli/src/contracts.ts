import type { Address } from 'viem';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SERVICE_REGISTRY_ADDRESS_DEFAULT: Address =
  '0x0000000000000000000000000000000000000000' as Address;

export const PAYMENT_CHANNEL_ADDRESS_DEFAULT: Address =
  '0x0000000000000000000000000000000000000000' as Address;

export const USDC_BASE_SEPOLIA: Address =
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

export const serviceRegistryAbi = [
  {
    type: 'function',
    name: 'register',
    inputs: [
      { name: 'metadataURI', type: 'string', internalType: 'string' },
      { name: 'pricePerRequest', type: 'uint256', internalType: 'uint256' },
      { name: 'maxResponseMs', type: 'uint32', internalType: 'uint32' },
    ],
    outputs: [{ name: 'serviceId', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'getService',
    inputs: [{ name: 'serviceId', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct ServiceRegistry.Service',
        components: [
          { name: 'provider', type: 'address', internalType: 'address' },
          { name: 'metadataURI', type: 'string', internalType: 'string' },
          { name: 'pricePerRequest', type: 'uint256', internalType: 'uint256' },
          { name: 'maxResponseMs', type: 'uint32', internalType: 'uint32' },
          { name: 'registeredAt', type: 'uint32', internalType: 'uint32' },
          { name: 'active', type: 'bool', internalType: 'bool' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getServiceCount',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getServiceAtIndex',
    inputs: [{ name: 'index', type: 'uint256', internalType: 'uint256' }],
    outputs: [
      { name: 'serviceId', type: 'bytes32', internalType: 'bytes32' },
      {
        name: 'svc',
        type: 'tuple',
        internalType: 'struct ServiceRegistry.Service',
        components: [
          { name: 'provider', type: 'address', internalType: 'address' },
          { name: 'metadataURI', type: 'string', internalType: 'string' },
          { name: 'pricePerRequest', type: 'uint256', internalType: 'uint256' },
          { name: 'maxResponseMs', type: 'uint32', internalType: 'uint32' },
          { name: 'registeredAt', type: 'uint32', internalType: 'uint32' },
          { name: 'active', type: 'bool', internalType: 'bool' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'deactivateService',
    inputs: [{ name: 'serviceId', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'updateService',
    inputs: [
      { name: 'serviceId', type: 'bytes32', internalType: 'bytes32' },
      { name: 'metadataURI', type: 'string', internalType: 'string' },
      { name: 'pricePerRequest', type: 'uint256', internalType: 'uint256' },
      { name: 'maxResponseMs', type: 'uint32', internalType: 'uint32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'ServiceRegistered',
    inputs: [
      { name: 'serviceId', type: 'bytes32', indexed: true },
      { name: 'provider', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'ServiceUpdated',
    inputs: [{ name: 'serviceId', type: 'bytes32', indexed: true }],
  },
  {
    type: 'event',
    name: 'ServiceDeactivated',
    inputs: [{ name: 'serviceId', type: 'bytes32', indexed: true }],
  },
  {
    type: 'error',
    name: 'ServiceAlreadyRegistered',
    inputs: [{ name: 'serviceId', type: 'bytes32' }],
  },
  {
    type: 'error',
    name: 'ServiceNotFound',
    inputs: [{ name: 'serviceId', type: 'bytes32' }],
  },
  {
    type: 'error',
    name: 'NotProvider',
    inputs: [
      { name: 'caller', type: 'address' },
      { name: 'provider', type: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'ServiceInactive',
    inputs: [{ name: 'serviceId', type: 'bytes32' }],
  },
  {
    type: 'error',
    name: 'InvalidMetadataURI',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidPrice',
    inputs: [],
  },
] as const;

export const paymentChannelAbi = [
  {
    type: 'constructor',
    inputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'openChannel',
    inputs: [
      { name: 'payee', type: 'address', internalType: 'address' },
      { name: 'token', type: 'address', internalType: 'address' },
      { name: 'deposit', type: 'uint256', internalType: 'uint256' },
      { name: 'expiresAt', type: 'uint32', internalType: 'uint32' },
      { name: 'policy', type: 'address', internalType: 'address' },
      { name: 'metadata', type: 'bytes', internalType: 'bytes' },
    ],
    outputs: [{ name: 'channelId', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'closeChannel',
    inputs: [
      { name: 'channelId', type: 'uint256', internalType: 'uint256' },
      { name: 'spent', type: 'uint256', internalType: 'uint256' },
      { name: 'signature', type: 'bytes', internalType: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'refundChannel',
    inputs: [{ name: 'channelId', type: 'uint256', internalType: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'extendChannel',
    inputs: [
      { name: 'channelId', type: 'uint256', internalType: 'uint256' },
      { name: 'newExpiry', type: 'uint32', internalType: 'uint32' },
      { name: 'additionalDeposit', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'getChannel',
    inputs: [{ name: 'channelId', type: 'uint256', internalType: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct PaymentChannel.Channel',
        components: [
          { name: 'payer', type: 'address', internalType: 'address' },
          { name: 'payee', type: 'address', internalType: 'address' },
          { name: 'token', type: 'address', internalType: 'address' },
          { name: 'deposit', type: 'uint256', internalType: 'uint256' },
          { name: 'spent', type: 'uint256', internalType: 'uint256' },
          { name: 'openedAt', type: 'uint32', internalType: 'uint32' },
          { name: 'expiresAt', type: 'uint32', internalType: 'uint32' },
          { name: 'policy', type: 'address', internalType: 'address' },
          { name: 'metadata', type: 'bytes', internalType: 'bytes' },
          { name: 'status', type: 'uint8', internalType: 'enum PaymentChannel.Status' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getChannelCount',
    inputs: [],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'CHANNEL_CLOSE_TYPEHASH',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'ChannelOpened',
    inputs: [
      { name: 'channelId', type: 'uint256', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'payee', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: false },
      { name: 'deposit', type: 'uint256', indexed: false },
      { name: 'expiresAt', type: 'uint32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ChannelClosed',
    inputs: [
      { name: 'channelId', type: 'uint256', indexed: true },
      { name: 'spent', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ChannelRefunded',
    inputs: [{ name: 'channelId', type: 'uint256', indexed: true }],
  },
  {
    type: 'event',
    name: 'ChannelExtended',
    inputs: [
      { name: 'channelId', type: 'uint256', indexed: true },
      { name: 'newExpiry', type: 'uint32', indexed: false },
      { name: 'additionalDeposit', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'error',
    name: 'ChannelNotFound',
    inputs: [{ name: 'channelId', type: 'uint256' }],
  },
  {
    type: 'error',
    name: 'ChannelNotOpen',
    inputs: [{ name: 'channelId', type: 'uint256' }],
  },
  {
    type: 'error',
    name: 'NotPayer',
    inputs: [
      { name: 'channelId', type: 'uint256' },
      { name: 'caller', type: 'address' },
      { name: 'payer', type: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'NotPayee',
    inputs: [
      { name: 'channelId', type: 'uint256' },
      { name: 'caller', type: 'address' },
      { name: 'payee', type: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'ChannelNotExpired',
    inputs: [
      { name: 'channelId', type: 'uint256' },
      { name: 'expiresAt', type: 'uint32' },
      { name: 'currentTime', type: 'uint32' },
    ],
  },
  {
    type: 'error',
    name: 'SpentExceedsDeposit',
    inputs: [
      { name: 'spent', type: 'uint256' },
      { name: 'deposit', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'InvalidExpiry',
    inputs: [
      { name: 'newExpiry', type: 'uint32' },
      { name: 'currentExpiry', type: 'uint32' },
    ],
  },
  {
    type: 'error',
    name: 'PolicyRejected',
    inputs: [{ name: 'policy', type: 'address' }],
  },
  {
    type: 'error',
    name: 'InvalidSignature',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TransferFailed',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroDeposit',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroToken',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ZeroPayee',
    inputs: [],
  },
  {
    type: 'error',
    name: 'ExpiryInPast',
    inputs: [
      { name: 'expiresAt', type: 'uint32' },
      { name: 'currentTime', type: 'uint32' },
    ],
  },
] as const;

export const SPENDING_POLICY_ADDRESS_DEFAULT: Address =
  '0x0000000000000000000000000000000000000000' as Address;

export const spendingPolicyAbi = [
  {
    type: 'function',
    name: 'setPolicy',
    inputs: [
      { name: 'payer', type: 'address', internalType: 'address' },
      { name: 'payee', type: 'address', internalType: 'address' },
      { name: 'deposit', type: 'uint256', internalType: 'uint256' },
      { name: 'metadata', type: 'bytes', internalType: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'validateChannelClose',
    inputs: [
      { name: 'payer', type: 'address', internalType: 'address' },
      { name: 'payee', type: 'address', internalType: 'address' },
      { name: 'deposit', type: 'uint256', internalType: 'uint256' },
      { name: 'spent', type: 'uint256', internalType: 'uint256' },
      { name: 'metadata', type: 'bytes', internalType: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getPolicy',
    inputs: [
      { name: 'payer', type: 'address', internalType: 'address' },
      { name: 'payee', type: 'address', internalType: 'address' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct SpendingPolicy.Policy',
        components: [
          { name: 'payer', type: 'address', internalType: 'address' },
          { name: 'payee', type: 'address', internalType: 'address' },
          { name: 'deposit', type: 'uint256', internalType: 'uint256' },
          { name: 'metadata', type: 'bytes', internalType: 'bytes' },
          { name: 'active', type: 'bool', internalType: 'bool' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'deactivatePolicy',
    inputs: [
      { name: 'payer', type: 'address', internalType: 'address' },
      { name: 'payee', type: 'address', internalType: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'PolicySet',
    inputs: [
      { name: 'payer', type: 'address', indexed: true },
      { name: 'payee', type: 'address', indexed: true },
      { name: 'deposit', type: 'uint256', indexed: false },
      { name: 'metadata', type: 'bytes', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PolicyDeactivated',
    inputs: [
      { name: 'payer', type: 'address', indexed: true },
      { name: 'payee', type: 'address', indexed: true },
    ],
  },
  {
    type: 'error',
    name: 'PolicyNotFound',
    inputs: [],
  },
  {
    type: 'error',
    name: 'PolicyInactive',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NotPayer',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidDeposit',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidSpend',
    inputs: [],
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
