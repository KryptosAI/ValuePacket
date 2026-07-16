import { createConfig } from "@ponder/core";
import { http } from "viem";
import { baseSepolia } from "viem/chains";

export default createConfig({
  networks: {
    baseSepolia: {
      chainId: 84532,
      transport: http(process.env.PONDER_RPC_URL_84532),
    },
  },
  contracts: {
    ServiceRegistry: {
      network: "baseSepolia",
      abi: [
        {
          type: "function",
          name: "register",
          inputs: [
            { name: "metadataURI", type: "string" },
            { name: "pricePerRequest", type: "uint256" },
            { name: "maxResponseMs", type: "uint32" },
          ],
          outputs: [{ name: "serviceId", type: "bytes32" }],
          stateMutability: "nonpayable",
        },
        {
          type: "function",
          name: "updateService",
          inputs: [
            { name: "serviceId", type: "bytes32" },
            { name: "metadataURI", type: "string" },
            { name: "pricePerRequest", type: "uint256" },
            { name: "maxResponseMs", type: "uint32" },
          ],
          outputs: [],
          stateMutability: "nonpayable",
        },
        {
          type: "function",
          name: "deactivateService",
          inputs: [{ name: "serviceId", type: "bytes32" }],
          outputs: [],
          stateMutability: "nonpayable",
        },
        {
          type: "function",
          name: "getService",
          inputs: [{ name: "serviceId", type: "bytes32" }],
          outputs: [
            {
              name: "",
              type: "tuple",
              components: [
                { name: "provider", type: "address" },
                { name: "metadataURI", type: "string" },
                { name: "pricePerRequest", type: "uint256" },
                { name: "maxResponseMs", type: "uint32" },
                { name: "registeredAt", type: "uint32" },
                { name: "active", type: "bool" },
              ],
            },
          ],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "getServiceCount",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "getServiceAtIndex",
          inputs: [{ name: "index", type: "uint256" }],
          outputs: [
            { name: "", type: "bytes32" },
            {
              name: "",
              type: "tuple",
              components: [
                { name: "provider", type: "address" },
                { name: "metadataURI", type: "string" },
                { name: "pricePerRequest", type: "uint256" },
                { name: "maxResponseMs", type: "uint32" },
                { name: "registeredAt", type: "uint32" },
                { name: "active", type: "bool" },
              ],
            },
          ],
          stateMutability: "view",
        },
        {
          type: "event",
          name: "ServiceRegistered",
          inputs: [
            { name: "serviceId", type: "bytes32", indexed: true },
            { name: "provider", type: "address", indexed: true },
          ],
          anonymous: false,
        },
        {
          type: "event",
          name: "ServiceUpdated",
          inputs: [
            { name: "serviceId", type: "bytes32", indexed: true },
          ],
          anonymous: false,
        },
        {
          type: "event",
          name: "ServiceDeactivated",
          inputs: [
            { name: "serviceId", type: "bytes32", indexed: true },
          ],
          anonymous: false,
        },
      ] as const,
      address: process.env
        .SERVICE_REGISTRY_ADDRESS as `0x${string}`,
      startBlock: 0,
    },
    PaymentChannel: {
      network: "baseSepolia",
      abi: [
        {
          type: "function",
          name: "openChannel",
          inputs: [
            { name: "payee", type: "address" },
            { name: "token", type: "address" },
            { name: "deposit", type: "uint256" },
            { name: "expiresAt", type: "uint32" },
            { name: "policy", type: "address" },
            { name: "metadata", type: "bytes" },
          ],
          outputs: [{ name: "channelId", type: "uint256" }],
          stateMutability: "nonpayable",
        },
        {
          type: "function",
          name: "closeChannel",
          inputs: [
            { name: "channelId", type: "uint256" },
            { name: "spent", type: "uint256" },
            { name: "signature", type: "bytes" },
          ],
          outputs: [],
          stateMutability: "nonpayable",
        },
        {
          type: "function",
          name: "refundChannel",
          inputs: [{ name: "channelId", type: "uint256" }],
          outputs: [],
          stateMutability: "nonpayable",
        },
        {
          type: "function",
          name: "extendChannel",
          inputs: [
            { name: "channelId", type: "uint256" },
            { name: "newExpiry", type: "uint32" },
            { name: "additionalDeposit", type: "uint256" },
          ],
          outputs: [],
          stateMutability: "nonpayable",
        },
        {
          type: "function",
          name: "getChannel",
          inputs: [{ name: "channelId", type: "uint256" }],
          outputs: [
            {
              name: "",
              type: "tuple",
              components: [
                { name: "payer", type: "address" },
                { name: "payee", type: "address" },
                { name: "token", type: "address" },
                { name: "deposit", type: "uint256" },
                { name: "spent", type: "uint256" },
                { name: "openedAt", type: "uint32" },
                { name: "expiresAt", type: "uint32" },
                { name: "policy", type: "address" },
                { name: "metadata", type: "bytes" },
                { name: "status", type: "uint8" },
              ],
            },
          ],
          stateMutability: "view",
        },
        {
          type: "event",
          name: "ChannelOpened",
          inputs: [
            { name: "channelId", type: "uint256", indexed: true },
            { name: "payer", type: "address", indexed: true },
            { name: "payee", type: "address", indexed: true },
            { name: "token", type: "address", indexed: false },
            { name: "deposit", type: "uint256", indexed: false },
            { name: "expiresAt", type: "uint32", indexed: false },
          ],
          anonymous: false,
        },
        {
          type: "event",
          name: "ChannelClosed",
          inputs: [
            { name: "channelId", type: "uint256", indexed: true },
            { name: "spent", type: "uint256", indexed: false },
          ],
          anonymous: false,
        },
        {
          type: "event",
          name: "ChannelRefunded",
          inputs: [
            { name: "channelId", type: "uint256", indexed: true },
          ],
          anonymous: false,
        },
        {
          type: "event",
          name: "ChannelExtended",
          inputs: [
            { name: "channelId", type: "uint256", indexed: true },
            { name: "newExpiry", type: "uint32", indexed: false },
            { name: "additionalDeposit", type: "uint256", indexed: false },
          ],
          anonymous: false,
        },
      ] as const,
      address: process.env
        .PAYMENT_CHANNEL_ADDRESS as `0x${string}`,
      startBlock: 0,
    },
  },
});
