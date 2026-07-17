// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockAxelarGateway {
    event SettlementRelayed(address indexed settlement, bytes32 indexed paymentId);

    function relaySettleFromSource(
        address settlement,
        bytes32 paymentId,
        uint256 channelId,
        uint256 spent,
        bytes calldata signature
    ) external {
        (bool ok, ) = settlement.call(
            abi.encodeWithSignature(
                "settleFromSource(bytes32,uint256,uint256,bytes)",
                paymentId, channelId, spent, signature
            )
        );
        require(ok, "MockAxelarGateway: settleFromSource failed");
        emit SettlementRelayed(settlement, paymentId);
    }
}
