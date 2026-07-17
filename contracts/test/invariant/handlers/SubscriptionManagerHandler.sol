// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymentChannel} from "../../../src/PaymentChannel.sol";
import {SubscriptionManager} from "../../../src/extensions/SubscriptionManager.sol";
import {MockUSDC} from "../../../src/mocks/MockUSDC.sol";

contract SubscriptionManagerHandler is Test {
    SubscriptionManager public immutable subManager;
    PaymentChannel public immutable channels;
    MockUSDC public immutable usdc;

    uint256 internal constant PAYER_KEY = 0xA11CE;
    address public immutable subPayer;
    address public immutable subPayee;
    bytes32 internal immutable domainSeparator;

    uint256[] public subIds;

    constructor(SubscriptionManager _subManager, PaymentChannel _channels, MockUSDC _usdc) {
        subManager = _subManager;
        channels = _channels;
        usdc = _usdc;
        subPayer = vm.addr(PAYER_KEY);
        subPayee = makeAddr("subPayee");

        domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ValuePacket")),
                keccak256(bytes("1")),
                block.chainid,
                address(subManager)
            )
        );

        usdc.mint(subPayer, type(uint128).max);
        vm.prank(subPayer);
        usdc.approve(address(subManager), type(uint256).max);
    }

    function subCount() external view returns (uint256) {
        return subIds.length;
    }

    function createSubscription(
        uint256 amountSeed,
        uint256 depositSeed,
        uint256 durationSeed
    ) external {
        uint256 amount = bound(amountSeed, 1, 1_000e6);
        uint256 deposit = bound(depositSeed, amount, amount * 10);
        uint32 duration = uint32(bound(durationSeed, 1 hours, 7 days));

        vm.prank(subPayer);
        uint256 id = subManager.createSubscription(
            subPayee, address(usdc), amount, duration, 0, deposit, ""
        );
        subIds.push(id);
    }

    function renew(uint256 idSeed, uint256 spentSeed) external {
        uint256 id = _pickActive(idSeed);
        if (id == 0) return;

        SubscriptionManager.Subscription memory sub = subManager.getSubscription(id);
        PaymentChannel.Channel memory ch = channels.getChannel(sub.activeChannelId);
        if (ch.status != PaymentChannel.Status.Open) return;

        vm.warp(uint256(ch.expiresAt) + 1);

        uint256 held = subManager.heldBalance(id);
        uint256 maxSpent = held < sub.amountPerPeriod ? held : sub.amountPerPeriod;
        uint256 spent = bound(spentSeed, 0, maxSpent);

        bytes32 salt = keccak256(abi.encode(id, sub.completedPeriods + 1));
        bytes32 structHash = keccak256(
            abi.encode(
                subManager.SUBSCRIPTION_AUTH_TYPEHASH(),
                id,
                sub.amountPerPeriod,
                sub.periodDuration,
                sub.maxPeriods,
                salt
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_KEY, digest);

        vm.prank(subPayee);
        subManager.renew(id, spent, salt, abi.encodePacked(r, s, v));
    }

    function cancel(uint256 idSeed) external {
        uint256 id = _pickActive(idSeed);
        if (id == 0) return;

        vm.prank(subPayer);
        subManager.cancel(id);
    }

    function sweep(uint256 idSeed) external {
        uint256 n = subIds.length;
        if (n == 0) return;
        uint256 start = idSeed % n;
        for (uint256 i = 0; i < n; i++) {
            uint256 id = subIds[(start + i) % n];
            SubscriptionManager.Subscription memory sub = subManager.getSubscription(id);
            if (sub.active || sub.activeChannelId == 0) continue;

            PaymentChannel.Channel memory ch = channels.getChannel(sub.activeChannelId);
            if (ch.status == PaymentChannel.Status.Open) {
                vm.warp(uint256(ch.expiresAt) + 1);
            }
            subManager.sweepCancelledSubscription(id);
            return;
        }
    }

    function _pickActive(uint256 seed) internal view returns (uint256) {
        uint256 n = subIds.length;
        if (n == 0) return 0;
        uint256 start = seed % n;
        for (uint256 i = 0; i < n; i++) {
            uint256 id = subIds[(start + i) % n];
            if (subManager.getSubscription(id).active) {
                return id;
            }
        }
        return 0;
    }
}
