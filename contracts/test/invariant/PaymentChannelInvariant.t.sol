// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {PaymentChannel} from "../../src/PaymentChannel.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {PaymentChannelHandler} from "./handlers/PaymentChannelHandler.sol";

contract PaymentChannelInvariantTest is StdInvariant, Test {
    PaymentChannel public channels;
    MockUSDC public usdc;
    PaymentChannelHandler public handler;

    function setUp() public {
        usdc = new MockUSDC();
        channels = new PaymentChannel();
        handler = new PaymentChannelHandler(channels, usdc);

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = PaymentChannelHandler.openChannel.selector;
        selectors[1] = PaymentChannelHandler.closeChannel.selector;
        selectors[2] = PaymentChannelHandler.refundChannel.selector;
        selectors[3] = PaymentChannelHandler.extendChannel.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Contract token balance must always cover the sum of open-channel obligations.
    function invariant_BalanceCoversOpenChannels() public view {
        uint256 obligations;
        uint256 n = handler.channelCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.channelIds(i);
            PaymentChannel.Channel memory ch = channels.getChannel(id);
            if (ch.status == PaymentChannel.Status.Open) {
                obligations += ch.deposit - ch.spent;
            }
        }
        assertGe(usdc.balanceOf(address(channels)), obligations);
    }

    /// Status transitions only Open -> Settled/Refunded; final states are terminal.
    function invariant_StatusTransitionsTerminal() public view {
        uint256 n = handler.channelCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 id = handler.channelIds(i);
            PaymentChannel.Channel memory ch = channels.getChannel(id);
            if (handler.isFinalized(id)) {
                assertEq(uint256(ch.status), uint256(handler.recordedFinalStatus(id)));
            } else {
                assertEq(uint256(ch.status), uint256(PaymentChannel.Status.Open));
            }
        }
    }
}
