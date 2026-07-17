// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {PaymentChannel} from "../../src/PaymentChannel.sol";
import {SubscriptionManager} from "../../src/extensions/SubscriptionManager.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {SubscriptionManagerHandler} from "./handlers/SubscriptionManagerHandler.sol";

contract SubscriptionManagerInvariantTest is StdInvariant, Test {
    PaymentChannel public channels;
    SubscriptionManager public subManager;
    MockUSDC public usdc;
    SubscriptionManagerHandler public handler;

    function setUp() public {
        usdc = new MockUSDC();
        channels = new PaymentChannel();
        subManager = new SubscriptionManager(channels);
        handler = new SubscriptionManagerHandler(subManager, channels, usdc);

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = SubscriptionManagerHandler.createSubscription.selector;
        selectors[1] = SubscriptionManagerHandler.renew.selector;
        selectors[2] = SubscriptionManagerHandler.cancel.selector;
        selectors[3] = SubscriptionManagerHandler.sweep.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// The manager's token balance must always cover the sum of all subscriptions'
    /// per-subscription held balances (channel deposits live in PaymentChannel).
    function invariant_BalanceCoversHeldBalances() public view {
        uint256 heldSum;
        uint256 n = handler.subCount();
        for (uint256 i = 0; i < n; i++) {
            heldSum += subManager.heldBalance(handler.subIds(i));
        }
        assertGe(usdc.balanceOf(address(subManager)), heldSum);
    }
}
