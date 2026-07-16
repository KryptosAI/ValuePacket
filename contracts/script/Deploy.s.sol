// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {ServiceRegistry} from "../src/ServiceRegistry.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";
import {SpendingPolicy} from "../src/SpendingPolicy.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envOr(
            "DEPLOYER_PRIVATE_KEY",
            uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)
        );
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        MockUSDC mockUSDC = new MockUSDC();
        console.log("MockUSDC deployed at:", address(mockUSDC));

        ServiceRegistry serviceRegistry = new ServiceRegistry();
        console.log("ServiceRegistry deployed at:", address(serviceRegistry));

        PaymentChannel paymentChannel = new PaymentChannel();
        console.log("PaymentChannel deployed at:", address(paymentChannel));

        SpendingPolicy spendingPolicy = new SpendingPolicy(address(serviceRegistry));
        console.log("SpendingPolicy deployed at:", address(spendingPolicy));

        mockUSDC.mint(deployer, 1_000_000 * 10 ** 6);
        console.log("Minted 1,000,000 USDC to deployer");

        vm.stopBroadcast();

        console.log("");
        console.log("---");
        console.log("MOCK_USDC=", address(mockUSDC));
        console.log("SERVICE_REGISTRY=", address(serviceRegistry));
        console.log("PAYMENT_CHANNEL=", address(paymentChannel));
        console.log("SPENDING_POLICY=", address(spendingPolicy));
        console.log("DEPLOYER=", deployer);
        console.log("CHAIN_ID=", block.chainid);
    }
}
