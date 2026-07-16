// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";
import {SubscriptionManager} from "../src/extensions/SubscriptionManager.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

contract SubscriptionManagerTest is Test {
    SubscriptionManager public subManager;
    PaymentChannel public channels;
    MockUSDC public usdc;

    address public payer;
    address public payee;
    address public other;

    uint256 public payerKey = 0xA11CE;
    uint256 public payeeKey = 0xB0B;
    uint256 public otherKey = 0xDEAD;

    bytes32 private DOMAIN_SEPARATOR;

    event SubscriptionCreated(
        uint256 indexed subscriptionId,
        address indexed payer,
        address indexed payee,
        uint256 amountPerPeriod
    );
    event SubscriptionRenewed(
        uint256 indexed subscriptionId,
        uint256 newChannelId,
        uint256 spentLastPeriod,
        uint256 periodNumber
    );
    event SubscriptionCancelled(uint256 indexed subscriptionId, uint256 refunded);

    function setUp() public {
        payer = vm.addr(payerKey);
        payee = vm.addr(payeeKey);
        other = vm.addr(otherKey);

        usdc = new MockUSDC();
        channels = new PaymentChannel();
        subManager = new SubscriptionManager(channels);

        DOMAIN_SEPARATOR = keccak256(
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

        usdc.mint(payer, 10_000_000e6);
        usdc.mint(other, 10_000_000e6);

        vm.prank(payer);
        usdc.approve(address(subManager), type(uint256).max);
        vm.prank(other);
        usdc.approve(address(subManager), type(uint256).max);
    }

    function _signSubscriptionAuth(
        uint256 signerKey,
        uint256 subscriptionId,
        uint256 amountPerPeriod,
        uint32 periodDuration,
        uint256 maxPeriods,
        bytes32 salt
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                subManager.SUBSCRIPTION_AUTH_TYPEHASH(),
                subscriptionId,
                amountPerPeriod,
                periodDuration,
                maxPeriods,
                salt
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _defaultAmount() internal pure returns (uint256) {
        return 100e6;
    }

    function _defaultDuration() internal pure returns (uint32) {
        return uint32(7 days);
    }

    function _defaultDeposit() internal pure returns (uint256) {
        return 300e6;
    }

    // ─── Create Subscription ────────────────────────────────────────────────

    function test_CreateSubscription() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();
        uint256 deposit = _defaultDeposit();
        bytes memory meta = hex"abcdef";

        uint256 payerBalBefore = usdc.balanceOf(payer);
        uint256 channelCountBefore = channels.getChannelCount();

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, deposit, meta
        );

        assertEq(subId, 1);
        assertEq(subManager.getSubscriptionCount(), 1);
        assertEq(usdc.balanceOf(payer), payerBalBefore - deposit);
        assertEq(usdc.balanceOf(address(subManager)), deposit - amount);
        assertEq(usdc.balanceOf(address(channels)), amount);
        assertEq(channels.getChannelCount(), channelCountBefore + 1);

        SubscriptionManager.Subscription memory sub = subManager.getSubscription(subId);
        assertEq(sub.payer, payer);
        assertEq(sub.payee, payee);
        assertEq(sub.token, address(usdc));
        assertEq(sub.amountPerPeriod, amount);
        assertEq(sub.periodDuration, duration);
        assertEq(sub.maxPeriods, 0);
        assertEq(sub.completedPeriods, 0);
        assertEq(sub.totalDeposited, deposit);
        assertEq(sub.totalSpent, 0);
        assertEq(sub.activeChannelId, 1);
        assertTrue(sub.active);
        assertEq(sub.metadata, meta);
    }

    function test_CreateSubscription_EmitsEvent() public {
        uint256 amount = _defaultAmount();

        vm.prank(payer);
        vm.expectEmit(true, true, true, false);
        emit SubscriptionCreated(1, payer, payee, amount);
        subManager.createSubscription(
            payee, address(usdc), amount, _defaultDuration(), 0, _defaultDeposit(), ""
        );
    }

    function test_CreateSubscription_WithMaxPeriods() public {
        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), _defaultAmount(), _defaultDuration(), 5, _defaultDeposit(), ""
        );

        SubscriptionManager.Subscription memory sub = subManager.getSubscription(subId);
        assertEq(sub.maxPeriods, 5);
        assertEq(sub.completedPeriods, 0);
    }

    function test_CreateSubscription_ExactDeposit() public {
        uint256 amount = 100e6;

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, _defaultDuration(), 0, amount, ""
        );

        SubscriptionManager.Subscription memory sub = subManager.getSubscription(subId);
        assertEq(sub.totalDeposited, amount);
        assertEq(usdc.balanceOf(address(subManager)), 0);
        assertEq(usdc.balanceOf(address(channels)), amount);
    }

    function test_CreateSubscription_CounterIncrements() public {
        vm.prank(payer);
        uint256 id1 = subManager.createSubscription(
            payee, address(usdc), _defaultAmount(), _defaultDuration(), 0, _defaultDeposit(), ""
        );

        usdc.mint(payer, _defaultDeposit());
        vm.prank(payer);
        uint256 id2 = subManager.createSubscription(
            other, address(usdc), _defaultAmount(), _defaultDuration(), 0, _defaultDeposit(), ""
        );

        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(subManager.getSubscriptionCount(), 2);
    }

    function test_CreateSubscription_ChannelHasCorrectParams() public {
        vm.prank(payer);
        subManager.createSubscription(
            payee, address(usdc), _defaultAmount(), _defaultDuration(), 0, _defaultDeposit(), ""
        );

        PaymentChannel.Channel memory ch = channels.getChannel(1);
        assertEq(ch.payer, address(subManager));
        assertEq(ch.payee, payee);
        assertEq(ch.token, address(usdc));
        assertEq(ch.deposit, _defaultAmount());
        assertEq(uint256(ch.status), uint256(PaymentChannel.Status.Open));
    }

    // ─── Revert: Create Subscription ────────────────────────────────────────

    function test_Revert_CreateSubscription_ZeroPayee() public {
        vm.prank(payer);
        vm.expectRevert(SubscriptionManager.ZeroAddress.selector);
        subManager.createSubscription(
            address(0), address(usdc), _defaultAmount(), _defaultDuration(), 0, _defaultDeposit(), ""
        );
    }

    function test_Revert_CreateSubscription_ZeroToken() public {
        vm.prank(payer);
        vm.expectRevert(SubscriptionManager.ZeroAddress.selector);
        subManager.createSubscription(
            payee, address(0), _defaultAmount(), _defaultDuration(), 0, _defaultDeposit(), ""
        );
    }

    function test_Revert_CreateSubscription_ZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(SubscriptionManager.ZeroAmount.selector);
        subManager.createSubscription(
            payee, address(usdc), 0, _defaultDuration(), 0, _defaultDeposit(), ""
        );
    }

    function test_Revert_CreateSubscription_InsufficientDeposit() public {
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionManager.InsufficientDeposit.selector, 50e6, 100e6)
        );
        subManager.createSubscription(
            payee, address(usdc), 100e6, _defaultDuration(), 0, 50e6, ""
        );
    }

    // ─── Renew ──────────────────────────────────────────────────────────────

    function test_RenewSubscription() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();
        uint256 spent = 80e6;
        bytes32 salt = bytes32(uint256(1));

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, _defaultDeposit(), ""
        );

        bytes memory sig = _signSubscriptionAuth(payerKey, subId, amount, duration, 0, salt);

        vm.warp(block.timestamp + duration + 1);

        uint256 payeeBalBefore = usdc.balanceOf(payee);

        vm.prank(payee);
        subManager.renew(subId, spent, salt, sig);

        assertEq(usdc.balanceOf(payee), payeeBalBefore + spent);

        SubscriptionManager.Subscription memory sub = subManager.getSubscription(subId);
        assertEq(sub.completedPeriods, 1);
        assertEq(sub.totalSpent, spent);
        assertTrue(sub.active);
        assertEq(sub.activeChannelId, 2);
    }

    function test_RenewSubscription_EmitsEvent() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();
        bytes32 salt = bytes32(uint256(1));

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, _defaultDeposit(), ""
        );

        bytes memory sig = _signSubscriptionAuth(payerKey, subId, amount, duration, 0, salt);

        vm.warp(block.timestamp + duration + 1);

        vm.prank(payee);
        vm.expectEmit(true, false, false, false);
        emit SubscriptionRenewed(subId, 2, amount, 1);
        subManager.renew(subId, amount, salt, sig);
    }

    function test_RenewSubscription_ZeroSpent() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();
        bytes32 salt = bytes32(uint256(1));

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, _defaultDeposit(), ""
        );

        bytes memory sig = _signSubscriptionAuth(payerKey, subId, amount, duration, 0, salt);

        vm.warp(block.timestamp + duration + 1);

        uint256 payeeBalBefore = usdc.balanceOf(payee);

        vm.prank(payee);
        subManager.renew(subId, 0, salt, sig);

        assertEq(usdc.balanceOf(payee), payeeBalBefore);

        SubscriptionManager.Subscription memory sub = subManager.getSubscription(subId);
        assertEq(sub.completedPeriods, 1);
        assertEq(sub.totalSpent, 0);
    }

    function test_MultipleRenewals() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();
        uint256 deposit = 500e6;

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, deposit, ""
        );

        uint256[3] memory spends = [uint256(70e6), uint256(100e6), uint256(50e6)];
        uint256 totalSpent;
        uint256 payeeBalBefore = usdc.balanceOf(payee);

        for (uint256 i = 0; i < spends.length; i++) {
            vm.warp(block.timestamp + duration + 1);
            bytes32 _salt = bytes32(uint256(i + 1));
            bytes memory _sig = _signSubscriptionAuth(payerKey, subId, amount, duration, 0, _salt);

            vm.prank(payee);
            subManager.renew(subId, spends[i], _salt, _sig);

            totalSpent += spends[i];
        }

        assertEq(usdc.balanceOf(payee), payeeBalBefore + totalSpent);

        SubscriptionManager.Subscription memory sub = subManager.getSubscription(subId);
        assertEq(sub.completedPeriods, 3);
        assertEq(sub.totalSpent, totalSpent);
        assertTrue(sub.active);
    }

    function test_MultipleRenewals_AccumulatedSpent() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();
        uint256 deposit = 500e6;

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 3, deposit, ""
        );

        for (uint256 i = 0; i < 3; i++) {
            vm.warp(block.timestamp + duration + 1);
            bytes32 salt = bytes32(uint256(i + 1));
            bytes memory sig = _signSubscriptionAuth(payerKey, subId, amount, duration, 3, salt);

            vm.prank(payee);
            subManager.renew(subId, amount, salt, sig);
        }

        SubscriptionManager.Subscription memory sub = subManager.getSubscription(subId);
        assertEq(sub.completedPeriods, 3);
        assertEq(sub.totalSpent, 3 * amount);

        uint256 channelBal = usdc.balanceOf(address(channels));
        assertEq(channelBal, amount);
    }

    // ─── Revert: Renew ─────────────────────────────────────────────────────

    function test_RevertRenew_NotFound() public {
        bytes memory sig = _signSubscriptionAuth(payerKey, 999, 100e6, uint32(7 days), 0, bytes32(0));

        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionManager.SubscriptionNotFound.selector, 999)
        );
        subManager.renew(999, 50e6, bytes32(0), sig);
    }

    function test_RevertRenew_NotActive() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, _defaultDeposit(), ""
        );

        // Cancel to deactivate
        vm.prank(payer);
        subManager.cancel(subId);

        bytes memory sig = _signSubscriptionAuth(payerKey, subId, amount, duration, 0, bytes32(0));

        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionManager.SubscriptionNotActive.selector, subId)
        );
        subManager.renew(subId, 10e6, bytes32(0), sig);
    }

    function test_RevertRenew_NotPayee() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, _defaultDeposit(), ""
        );

        bytes memory sig = _signSubscriptionAuth(payerKey, subId, amount, duration, 0, bytes32(0));

        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(
                SubscriptionManager.NotPayee.selector, subId, other, payee
            )
        );
        subManager.renew(subId, 10e6, bytes32(0), sig);
    }

    function test_RevertRenew_SpentExceedsAmount() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, _defaultDeposit(), ""
        );

        bytes memory sig = _signSubscriptionAuth(payerKey, subId, amount, duration, 0, bytes32(0));

        vm.warp(block.timestamp + duration + 1);

        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionManager.SpentExceedsAmount.selector, 200e6, amount)
        );
        subManager.renew(subId, 200e6, bytes32(0), sig);
    }

    function test_RevertRenew_WrongSignature() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, _defaultDeposit(), ""
        );

        // Signed by payee instead of payer
        bytes memory sig = _signSubscriptionAuth(payeeKey, subId, amount, duration, 0, bytes32(0));

        vm.warp(block.timestamp + duration + 1);

        vm.prank(payee);
        vm.expectRevert(SubscriptionManager.InvalidSignature.selector);
        subManager.renew(subId, amount, bytes32(0), sig);
    }

    function test_RevertRenew_WrongSubscriptionParams() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, _defaultDeposit(), ""
        );

        // Signature for different amount
        bytes memory sig = _signSubscriptionAuth(payerKey, subId, 200e6, duration, 0, bytes32(0));

        vm.warp(block.timestamp + duration + 1);

        vm.prank(payee);
        vm.expectRevert(SubscriptionManager.InvalidSignature.selector);
        subManager.renew(subId, amount, bytes32(0), sig);
    }

    function test_RevertRenew_WrongSubscriptionId() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, _defaultDeposit(), ""
        );

        // Signature for different subscription ID
        bytes memory sig = _signSubscriptionAuth(payerKey, 999, amount, duration, 0, bytes32(0));

        vm.warp(block.timestamp + duration + 1);

        vm.prank(payee);
        vm.expectRevert(SubscriptionManager.InvalidSignature.selector);
        subManager.renew(subId, amount, bytes32(0), sig);
    }

    function test_RevertRenew_ShortSignature() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, _defaultDeposit(), ""
        );

        vm.warp(block.timestamp + duration + 1);

        vm.prank(payee);
        vm.expectRevert(SubscriptionManager.InvalidSignature.selector);
        subManager.renew(subId, amount, bytes32(0), hex"deadbeef");
    }

    function test_RevertRenew_ChannelNotExpired() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, _defaultDeposit(), ""
        );

        bytes memory sig = _signSubscriptionAuth(payerKey, subId, amount, duration, 0, bytes32(0));

        // Still within same period
        uint256 timeBeforeWarp = block.timestamp;
        uint32 expectedExpiry = uint32(timeBeforeWarp) + duration;
        vm.warp(timeBeforeWarp + 1 days);

        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(
                SubscriptionManager.ChannelNotExpired.selector,
                1,
                expectedExpiry,
                uint32(block.timestamp)
            )
        );
        subManager.renew(subId, amount, bytes32(0), sig);
    }

    function test_RevertRenew_MaxPeriodsReached() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 2, _defaultDeposit(), ""
        );

        for (uint256 i = 0; i < 2; i++) {
            vm.warp(block.timestamp + duration + 1);
            bytes32 _salt = bytes32(uint256(i + 1));
            bytes memory _sig = _signSubscriptionAuth(payerKey, subId, amount, duration, 2, _salt);

            vm.prank(payee);
            subManager.renew(subId, amount, _salt, _sig);
        }

        // Attempt 3rd renewal
        vm.warp(block.timestamp + duration + 1);
        bytes32 salt = bytes32(uint256(3));
        bytes memory sig = _signSubscriptionAuth(payerKey, subId, amount, duration, 2, salt);

        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(
                SubscriptionManager.MaxPeriodsReached.selector, subId, 2, 2
            )
        );
        subManager.renew(subId, amount, salt, sig);
    }

    // ─── Cancel ─────────────────────────────────────────────────────────────

    function test_CancelSubscription_WithExpiredChannel() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();
        uint256 deposit = _defaultDeposit();

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, deposit, ""
        );

        vm.warp(block.timestamp + duration + 1);

        uint256 payerBalBefore = usdc.balanceOf(payer);

        vm.prank(payer);
        uint256 refunded = subManager.cancel(subId);

        assertGt(refunded, 0);
        assertEq(usdc.balanceOf(payer), payerBalBefore + refunded);
        assertEq(
            refunded,
            deposit - amount + amount // excess + channel deposit refund
        );

        SubscriptionManager.Subscription memory sub = subManager.getSubscription(subId);
        assertFalse(sub.active);
    }

    function test_CancelSubscription_AfterMultiplePeriods() public {
        uint256 amount = _defaultAmount();
        uint32 duration = _defaultDuration();
        uint256 deposit = 500e6;

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, deposit, ""
        );

        vm.warp(block.timestamp + duration + 1);
        bytes32 salt1 = bytes32(uint256(1));
        bytes memory sig1 = _signSubscriptionAuth(payerKey, subId, amount, duration, 0, salt1);

        vm.prank(payee);
        subManager.renew(subId, 80e6, salt1, sig1);

        // Now cancel
        vm.prank(payer);
        subManager.cancel(subId);

        // Payer deposited 500, spent 80, should get back ~420
        // But 100 is locked in active (unexpired) channel, so gets ~320
        SubscriptionManager.Subscription memory sub = subManager.getSubscription(subId);
        assertFalse(sub.active);
        assertEq(sub.totalSpent, 80e6);
    }

    function test_CancelSubscription_EmitsEvent() public {
        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), _defaultAmount(), _defaultDuration(), 0, _defaultDeposit(), ""
        );

        vm.warp(block.timestamp + _defaultDuration() + 1);

        vm.prank(payer);
        vm.expectEmit(true, false, false, false);
        emit SubscriptionCancelled(subId, _defaultDeposit());
        subManager.cancel(subId);
    }

    function test_CancelSubscription_ReturnsRemainingBalance() public {
        uint256 amount = 100e6;
        uint32 duration = _defaultDuration();
        uint256 deposit = 500e6;

        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, deposit, ""
        );

        vm.warp(block.timestamp + duration + 1);

        uint256 payerBalBefore = usdc.balanceOf(payer);

        vm.prank(payer);
        uint256 refunded = subManager.cancel(subId);

        // deposit=500, 100 went to channel. Channel refunded: +100. Total held: 500.
        // Refunded should be 500
        assertEq(refunded, 500e6);
        assertEq(usdc.balanceOf(payer), payerBalBefore + 500e6);
        assertEq(usdc.balanceOf(address(subManager)), 0);
    }

    function test_RevertCancel_NotPayer() public {
        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), _defaultAmount(), _defaultDuration(), 0, _defaultDeposit(), ""
        );

        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(
                SubscriptionManager.NotPayer.selector, subId, other, payer
            )
        );
        subManager.cancel(subId);
    }

    function test_RevertCancel_AlreadyCancelled() public {
        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), _defaultAmount(), _defaultDuration(), 0, _defaultDeposit(), ""
        );

        vm.warp(block.timestamp + _defaultDuration() + 1);

        vm.prank(payer);
        subManager.cancel(subId);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionManager.SubscriptionNotActive.selector, subId)
        );
        subManager.cancel(subId);
    }

    function test_RevertCancel_NotFound() public {
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionManager.SubscriptionNotFound.selector, 999)
        );
        subManager.cancel(999);
    }

    // ─── Get Subscription ───────────────────────────────────────────────────

    function test_GetSubscription_NotFound() public {
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionManager.SubscriptionNotFound.selector, 999)
        );
        subManager.getSubscription(999);
    }

    function test_GetSubscriptionCount_Zero() public {
        assertEq(subManager.getSubscriptionCount(), 0);
    }

    function test_GetSubscriptionCount_Increments() public {
        vm.prank(payer);
        subManager.createSubscription(
            payee, address(usdc), _defaultAmount(), _defaultDuration(), 0, _defaultDeposit(), ""
        );

        assertEq(subManager.getSubscriptionCount(), 1);

        vm.prank(payer);
        subManager.createSubscription(
            other, address(usdc), _defaultAmount(), _defaultDuration(), 0, _defaultDeposit(), ""
        );

        assertEq(subManager.getSubscriptionCount(), 2);
    }

    // ─── Full Integration Flow ─────────────────────────────────────────────

    function test_FullFlow() public {
        uint256 amount = 100e6;
        uint32 duration = 7 days;
        uint256 deposit = 500e6;
        bytes32 salt = bytes32(uint256(42));

        // 1. Create subscription
        vm.prank(payer);
        uint256 subId = subManager.createSubscription(
            payee, address(usdc), amount, duration, 0, deposit, hex""
        );

        assertEq(subManager.getSubscriptionCount(), 1);
        assertEq(channels.getChannelCount(), 1);

        // 2. Renew twice
        uint256 payeeBalBefore = usdc.balanceOf(payee);
        uint256 totalPaid;

        for (uint256 i = 0; i < 2; i++) {
            vm.warp(block.timestamp + duration + 1);
            bytes32 s = bytes32(uint256(keccak256(abi.encode(salt, i))));
            bytes memory sig = _signSubscriptionAuth(payerKey, subId, amount, duration, 0, s);

            vm.prank(payee);
            subManager.renew(subId, amount, s, sig);
            totalPaid += amount;
        }

        assertEq(usdc.balanceOf(payee), payeeBalBefore + totalPaid);

        SubscriptionManager.Subscription memory sub = subManager.getSubscription(subId);
        assertEq(sub.completedPeriods, 2);
        assertEq(sub.totalSpent, totalPaid);

        // 3. Cancel
        vm.warp(block.timestamp + duration + 1);

        uint256 payerBalBefore = usdc.balanceOf(payer);

        vm.prank(payer);
        uint256 refunded = subManager.cancel(subId);

        assertFalse(subManager.getSubscription(subId).active);
        assertEq(usdc.balanceOf(payer), payerBalBefore + refunded);
        assertEq(refunded, deposit - totalPaid);
    }
}
