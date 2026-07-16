// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ServiceRegistry} from "../src/ServiceRegistry.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";
import {SpendingPolicy} from "../src/SpendingPolicy.sol";

contract DeploySepolia is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Network: Base Sepolia");
        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);
        console.log("USDC token: 0x036CbD53842c5426634e7929541eC2318f3dCF7e");
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        ServiceRegistry serviceRegistry = new ServiceRegistry();
        console.log("ServiceRegistry deployed at:", address(serviceRegistry));

        PaymentChannel paymentChannel = new PaymentChannel();
        console.log("PaymentChannel deployed at:", address(paymentChannel));

        SpendingPolicy spendingPolicy = new SpendingPolicy(address(serviceRegistry));
        console.log("SpendingPolicy deployed at:", address(spendingPolicy));

        vm.stopBroadcast();

        string memory json = string.concat(
            '{\n',
            '  "serviceRegistry": "', vm.toString(address(serviceRegistry)), '",\n',
            '  "paymentChannel": "', vm.toString(address(paymentChannel)), '",\n',
            '  "spendingPolicy": "', vm.toString(address(spendingPolicy)), '",\n',
            '  "chainId": 84532,\n',
            '  "usdcToken": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"\n',
            '}'
        );

        vm.writeFile("./deployments/base-sepolia.json", json);

        console.log("");
        console.log("Deployment addresses written to deployments/base-sepolia.json");
    }
}
