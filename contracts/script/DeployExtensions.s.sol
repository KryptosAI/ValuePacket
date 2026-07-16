// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockEAS} from "../src/mocks/MockEAS.sol";
import {MockAxelarGateway} from "../src/mocks/MockAxelarGateway.sol";
import {AgentReputation} from "../src/extensions/AgentReputation.sol";
import {SubscriptionManager} from "../src/extensions/SubscriptionManager.sol";
import {CrossChainSettlement} from "../src/extensions/CrossChainSettlement.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";

contract DeployExtensions is Script {
    address constant EAS_BASE_SEPOLIA = 0x4200000000000000000000000000000000000021;
    uint256 constant ANVIL_CHAIN_ID = 31337;

    function run() external {
        uint256 deployerPrivateKey = vm.envOr(
            "DEPLOYER_PRIVATE_KEY",
            uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)
        );
        address deployer = vm.addr(deployerPrivateKey);
        uint256 chainId = block.chainid;
        address paymentChannelAddress = vm.envAddress("PAYMENT_CHANNEL_ADDRESS");

        console.log("Deployer:", deployer);
        console.log("Chain ID:", chainId);
        console.log("PaymentChannel:", paymentChannelAddress);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        address easAddress;
        if (chainId == ANVIL_CHAIN_ID) {
            MockEAS mockEAS = new MockEAS();
            easAddress = address(mockEAS);
            console.log("MockEAS deployed at:", easAddress);
        } else {
            easAddress = vm.envOr("EAS_ADDRESS", EAS_BASE_SEPOLIA);
            console.log("EAS address:", easAddress);
        }

        AgentReputation agentReputation = new AgentReputation(easAddress);
        console.log("AgentReputation deployed at:", address(agentReputation));

        SubscriptionManager subscriptionManager = new SubscriptionManager(
            PaymentChannel(paymentChannelAddress)
        );
        console.log("SubscriptionManager deployed at:", address(subscriptionManager));

        address axelarGateway;
        if (chainId == ANVIL_CHAIN_ID) {
            MockAxelarGateway mockGateway = new MockAxelarGateway();
            axelarGateway = address(mockGateway);
            console.log("MockAxelarGateway deployed at:", axelarGateway);
        } else {
            axelarGateway = vm.envAddress("AXELAR_GATEWAY_ADDRESS");
            console.log("Axelar Gateway address:", axelarGateway);
        }

        bytes32 sourceDomainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ValuePacket")),
                keccak256(bytes("1")),
                chainId,
                paymentChannelAddress
            )
        );

        uint256 timeout = vm.envOr("CROSS_CHAIN_TIMEOUT", uint256(7 days));
        console.log("Cross-chain timeout:", timeout, "seconds");

        CrossChainSettlement crossChainSettlement = new CrossChainSettlement(
            sourceDomainSeparator,
            chainId,
            axelarGateway,
            timeout
        );
        console.log("CrossChainSettlement deployed at:", address(crossChainSettlement));

        vm.stopBroadcast();

        console.log("");
        console.log("---");
        console.log("AGENT_REPUTATION=", address(agentReputation));
        console.log("SUBSCRIPTION_MANAGER=", address(subscriptionManager));
        console.log("CROSS_CHAIN_SETTLEMENT=", address(crossChainSettlement));
        console.log("EAS_ADDRESS=", easAddress);
        console.log("PAYMENT_CHANNEL=", paymentChannelAddress);
        console.log("AXELAR_GATEWAY=", axelarGateway);
        console.log("CHAIN_ID=", chainId);

        string memory chainIdStr = vm.toString(chainId);
        string memory json = string.concat(
            '{\n',
            '  "agentReputation": "', vm.toString(address(agentReputation)), '",\n',
            '  "subscriptionManager": "', vm.toString(address(subscriptionManager)), '",\n',
            '  "crossChainSettlement": "', vm.toString(address(crossChainSettlement)), '",\n',
            '  "easAddress": "', vm.toString(easAddress), '",\n',
            '  "paymentChannel": "', vm.toString(paymentChannelAddress), '",\n',
            '  "axelarGateway": "', vm.toString(axelarGateway), '",\n',
            '  "sourceDomainSeparator": "', vm.toString(sourceDomainSeparator), '",\n',
            '  "chainId": ', chainIdStr, '\n',
            '}'
        );

        vm.writeFile("./deployments/extensions.json", json);
        console.log("");
        console.log("Deployment addresses written to deployments/extensions.json");
    }
}
