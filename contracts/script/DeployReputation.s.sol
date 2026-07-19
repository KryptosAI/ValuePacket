// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script, console} from "forge-std/Script.sol";
import {AgentReputation} from "../src/extensions/AgentReputation.sol";
contract DeployRep is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);
        AgentReputation rep = new AgentReputation(0x4200000000000000000000000000000000000021);
        console.log("AgentReputation deployed at:", address(rep));
        console.log("EAS:", address(rep.EAS()));
        console.log("SCHEMA_UID:", vm.toString(rep.SCHEMA_UID()));
        vm.stopBroadcast();
    }
}
