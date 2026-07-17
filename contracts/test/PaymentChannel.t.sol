// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {PaymentChannel} from "../src/PaymentChannel.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract PaymentChannelTest is Test {
    PaymentChannel public channels;
    MockERC20 public token;

    address public payer = address(0x100);
    address public payee = address(0x200);
    address public other = address(0x300);

    uint256 public payerKey = 0xA11CE;
    uint256 public payeeKey = 0xB0B;

    bytes32 private DOMAIN_SEPARATOR;

    event ChannelOpened(
        uint256 indexed channelId,
        address indexed payer,
        address indexed payee,
        address token,
        uint256 deposit,
        uint32 expiresAt
    );
    event ChannelClosed(uint256 indexed channelId, uint256 spent);
    event ChannelRefunded(uint256 indexed channelId);
    event ChannelExtended(uint256 indexed channelId, uint32 newExpiry, uint256 additionalDeposit);

    function setUp() public {
        payer = vm.addr(payerKey);
        payee = vm.addr(payeeKey);
        other = vm.addr(0xDEAD);

        token = new MockERC20("TestToken", "TST", 18);
        channels = new PaymentChannel();

        // Build expected domain separator for signing
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ValuePacket")),
                keccak256(bytes("1")),
                block.chainid,
                address(channels)
            )
        );

        // Fund payer
        token.mint(payer, 1000 ether);
        token.mint(other, 1000 ether);

        vm.prank(payer);
        token.approve(address(channels), type(uint256).max);
        vm.prank(other);
        token.approve(address(channels), type(uint256).max);
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    function _signClose(
        uint256 signerKey,
        uint256 channelId,
        uint256 spent
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(channels.CHANNEL_CLOSE_TYPEHASH(), channelId, spent)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _openChannel(
        address _payer,
        address _payee,
        uint256 deposit,
        uint32 expiresAt
    ) internal returns (uint256) {
        vm.prank(_payer);
        return channels.openChannel(
            _payee,
            address(token),
            deposit,
            expiresAt,
            address(0),
            ""
        );
    }

    // ─── Open Channel ──────────────────────────────────────────────────────

    function test_OpenChannel() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 payerBalBefore = token.balanceOf(payer);
        uint256 contractBalBefore = token.balanceOf(address(channels));

        vm.prank(payer);
        uint256 channelId = channels.openChannel(
            payee, address(token), deposit, expiresAt, address(0), ""
        );

        assertEq(channelId, 1);
        assertEq(token.balanceOf(payer), payerBalBefore - deposit);
        assertEq(token.balanceOf(address(channels)), contractBalBefore + deposit);

        PaymentChannel.Channel memory ch = channels.getChannel(channelId);
        assertEq(ch.payer, payer);
        assertEq(ch.payee, payee);
        assertEq(ch.token, address(token));
        assertEq(ch.deposit, deposit);
        assertEq(ch.spent, 0);
        assertEq(ch.expiresAt, expiresAt);
        assertEq(uint256(ch.status), uint256(PaymentChannel.Status.Open));
        assertEq(ch.policy, address(0));
    }

    function test_OpenChannel_EmitsEvent() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        vm.prank(payer);
        vm.expectEmit(true, true, true, false);
        emit ChannelOpened(1, payer, payee, address(token), deposit, expiresAt);
        channels.openChannel(payee, address(token), deposit, expiresAt, address(0), "");
    }

    function test_OpenChannel_CounterIncrements() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 10 ether;

        vm.prank(payer);
        uint256 id1 = channels.openChannel(payee, address(token), deposit, expiresAt, address(0), "");

        vm.prank(payer);
        uint256 id2 = channels.openChannel(other, address(token), deposit, expiresAt, address(0), "");

        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(channels.getChannelCount(), 2);
    }

    function test_Revert_OpenChannel_ZeroPayee() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        vm.prank(payer);
        vm.expectRevert(PaymentChannel.ZeroPayee.selector);
        channels.openChannel(address(0), address(token), 100 ether, expiresAt, address(0), "");
    }

    function test_Revert_OpenChannel_ZeroToken() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        vm.prank(payer);
        vm.expectRevert(PaymentChannel.ZeroToken.selector);
        channels.openChannel(payee, address(0), 100 ether, expiresAt, address(0), "");
    }

    function test_Revert_OpenChannel_ZeroDeposit() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        vm.prank(payer);
        vm.expectRevert(PaymentChannel.ZeroDeposit.selector);
        channels.openChannel(payee, address(token), 0, expiresAt, address(0), "");
    }

    function test_Revert_OpenChannel_ExpiryInPast() public {
        uint32 pastExpiry = uint32(block.timestamp - 1);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaymentChannel.ExpiryInPast.selector,
                pastExpiry,
                uint32(block.timestamp)
            )
        );
        channels.openChannel(payee, address(token), 100 ether, pastExpiry, address(0), "");
    }

    function test_OpenChannel_WithPolicy() public {
        // Use a mock policy that always returns true
        MockPolicy policy = new MockPolicy(true);
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        vm.prank(payer);
        uint256 channelId = channels.openChannel(
            payee, address(token), deposit, expiresAt, address(policy), "hello"
        );

        PaymentChannel.Channel memory ch = channels.getChannel(channelId);
        assertEq(ch.policy, address(policy));
        assertEq(ch.metadata, "hello");
    }

    function test_Revert_OpenChannel_PolicyRejected() public {
        RejectOpenPolicy policy = new RejectOpenPolicy();
        uint32 expiresAt = uint32(block.timestamp + 7 days);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentChannel.PolicyRejected.selector, address(policy))
        );
        channels.openChannel(
            payee, address(token), 100 ether, expiresAt, address(policy), ""
        );
    }

    // ─── Close Channel ─────────────────────────────────────────────────────

    function test_CloseChannel_FullSpend() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        bytes memory sig = _signClose(payerKey, channelId, deposit);

        uint256 payeeBalBefore = token.balanceOf(payee);
        uint256 payerBalBefore = token.balanceOf(payer);
        uint256 contractBalBefore = token.balanceOf(address(channels));

        vm.prank(payee);
        channels.closeChannel(channelId, deposit, sig);

        assertEq(token.balanceOf(payee), payeeBalBefore + deposit);
        assertEq(token.balanceOf(payer), payerBalBefore);
        assertEq(token.balanceOf(address(channels)), contractBalBefore - deposit);

        PaymentChannel.Channel memory ch = channels.getChannel(channelId);
        assertEq(uint256(ch.status), uint256(PaymentChannel.Status.Settled));
        assertEq(ch.spent, deposit);
    }

    function test_CloseChannel_PartialSpend() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;
        uint256 spent = 40 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        bytes memory sig = _signClose(payerKey, channelId, spent);

        uint256 payeeBalBefore = token.balanceOf(payee);
        uint256 payerBalBefore = token.balanceOf(payer);

        vm.prank(payee);
        channels.closeChannel(channelId, spent, sig);

        assertEq(token.balanceOf(payee), payeeBalBefore + spent);
        assertEq(token.balanceOf(payer), payerBalBefore + (deposit - spent));

        PaymentChannel.Channel memory ch = channels.getChannel(channelId);
        assertEq(uint256(ch.status), uint256(PaymentChannel.Status.Settled));
        assertEq(ch.spent, spent);
    }

    function test_CloseChannel_EmitsEvent() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);
        bytes memory sig = _signClose(payerKey, channelId, deposit);

        vm.prank(payee);
        vm.expectEmit(true, false, false, true);
        emit ChannelClosed(channelId, deposit);
        channels.closeChannel(channelId, deposit, sig);
    }

    function test_Revert_CloseChannel_InvalidSignature() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        // Sign with wrong key (payee's key instead of payer's)
        bytes memory badSig = _signClose(payeeKey, channelId, deposit);

        vm.prank(payee);
        vm.expectRevert(PaymentChannel.InvalidSignature.selector);
        channels.closeChannel(channelId, deposit, badSig);
    }

    function test_Revert_CloseChannel_WrongSpent() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        // Signature is for spent=50 but we try spent=100
        bytes memory sig = _signClose(payerKey, channelId, 50 ether);

        vm.prank(payee);
        vm.expectRevert(PaymentChannel.InvalidSignature.selector);
        channels.closeChannel(channelId, 100 ether, sig);
    }

    function test_Revert_CloseChannel_WrongChannelId() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        // Sign a different channel (id 999)
        bytes memory sig = _signClose(payerKey, 999, deposit);

        vm.prank(payee);
        vm.expectRevert(PaymentChannel.InvalidSignature.selector);
        channels.closeChannel(channelId, deposit, sig);
    }

    function test_Revert_CloseChannel_NotPayee() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);
        bytes memory sig = _signClose(payerKey, channelId, deposit);

        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaymentChannel.NotPayee.selector,
                channelId,
                other,
                payee
            )
        );
        channels.closeChannel(channelId, deposit, sig);
    }

    function test_Revert_CloseChannel_SpentExceedsDeposit() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaymentChannel.SpentExceedsDeposit.selector,
                200 ether,
                deposit
            )
        );
        channels.closeChannel(channelId, 200 ether, "");
    }

    function test_Revert_CloseChannel_AlreadySettled() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);
        bytes memory sig = _signClose(payerKey, channelId, deposit);

        vm.prank(payee);
        channels.closeChannel(channelId, deposit, sig);

        // Try to close again
        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentChannel.ChannelNotOpen.selector, channelId)
        );
        channels.closeChannel(channelId, deposit, sig);
    }

    function test_CloseChannel_WithPolicy() public {
        MockPolicy policy = new MockPolicy(true);
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;
        uint256 spent = 30 ether;

        vm.prank(payer);
        uint256 channelId = channels.openChannel(
            payee, address(token), deposit, expiresAt, address(policy), ""
        );

        bytes memory sig = _signClose(payerKey, channelId, spent);

        vm.prank(payee);
        channels.closeChannel(channelId, spent, sig);

        PaymentChannel.Channel memory ch = channels.getChannel(channelId);
        assertEq(uint256(ch.status), uint256(PaymentChannel.Status.Settled));
        assertEq(ch.spent, spent);
    }

    function test_Revert_CloseChannel_PolicyRejected() public {
        MockPolicy policy = new MockPolicy(false);
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        vm.prank(payer);
        uint256 channelId = channels.openChannel(
            payee, address(token), deposit, expiresAt, address(policy), ""
        );

        bytes memory sig = _signClose(payerKey, channelId, deposit);

        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentChannel.PolicyRejected.selector, address(policy))
        );
        channels.closeChannel(channelId, deposit, sig);
    }

    // ─── Refund Channel ────────────────────────────────────────────────────

    function test_RefundChannel_AfterExpiry() public {
        uint32 expiresAt = uint32(block.timestamp + 1 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        // Warp past expiry
        vm.warp(block.timestamp + 2 days);

        uint256 payerBalBefore = token.balanceOf(payer);

        vm.prank(payer);
        channels.refundChannel(channelId);

        assertEq(token.balanceOf(payer), payerBalBefore + deposit);

        PaymentChannel.Channel memory ch = channels.getChannel(channelId);
        assertEq(uint256(ch.status), uint256(PaymentChannel.Status.Refunded));
    }

    function test_RefundChannel_EmitsEvent() public {
        uint32 expiresAt = uint32(block.timestamp + 1 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        vm.warp(block.timestamp + 2 days);

        vm.prank(payer);
        vm.expectEmit(true, false, false, false);
        emit ChannelRefunded(channelId);
        channels.refundChannel(channelId);
    }

    function test_Revert_RefundChannel_NotExpired() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaymentChannel.ChannelNotExpired.selector,
                channelId,
                expiresAt,
                uint32(block.timestamp)
            )
        );
        channels.refundChannel(channelId);
    }

    function test_Revert_RefundChannel_NotPayer() public {
        uint32 expiresAt = uint32(block.timestamp + 1 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);
        vm.warp(block.timestamp + 2 days);

        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaymentChannel.NotPayer.selector,
                channelId,
                other,
                payer
            )
        );
        channels.refundChannel(channelId);
    }

    function test_Revert_RefundChannel_AlreadySettled() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);
        bytes memory sig = _signClose(payerKey, channelId, deposit);

        vm.prank(payee);
        channels.closeChannel(channelId, deposit, sig);

        vm.warp(block.timestamp + 8 days);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentChannel.ChannelNotOpen.selector, channelId)
        );
        channels.refundChannel(channelId);
    }

    // ─── Extend Channel ────────────────────────────────────────────────────

    function test_ExtendChannel_NewExpiry() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        uint32 newExpiry = expiresAt + 7 days;

        vm.prank(payer);
        channels.extendChannel(channelId, newExpiry, 0);

        PaymentChannel.Channel memory ch = channels.getChannel(channelId);
        assertEq(ch.expiresAt, newExpiry);
        assertEq(ch.deposit, deposit);
    }

    function test_ExtendChannel_WithTopUp() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;
        uint256 topUp = 50 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        uint32 newExpiry = expiresAt + 7 days;

        vm.prank(payer);
        channels.extendChannel(channelId, newExpiry, topUp);

        PaymentChannel.Channel memory ch = channels.getChannel(channelId);
        assertEq(ch.expiresAt, newExpiry);
        assertEq(ch.deposit, deposit + topUp);
    }

    function test_ExtendChannel_EmitsEvent() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;
        uint256 topUp = 20 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        uint32 newExpiry = expiresAt + 7 days;

        vm.prank(payer);
        vm.expectEmit(true, false, false, false);
        emit ChannelExtended(channelId, newExpiry, topUp);
        channels.extendChannel(channelId, newExpiry, topUp);
    }

    function test_Revert_ExtendChannel_NotPayer() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        uint32 newExpiry = expiresAt + 7 days;

        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaymentChannel.NotPayer.selector,
                channelId,
                other,
                payer
            )
        );
        channels.extendChannel(channelId, newExpiry, 0);
    }

    function test_Revert_ExtendChannel_NotLaterExpiry() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        // Same expiry
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaymentChannel.InvalidExpiry.selector,
                expiresAt,
                expiresAt
            )
        );
        channels.extendChannel(channelId, expiresAt, 0);
    }

    function test_Revert_ExtendChannel_EarlierExpiry() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        uint32 newExpiry = expiresAt - 1 days;

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaymentChannel.InvalidExpiry.selector,
                newExpiry,
                expiresAt
            )
        );
        channels.extendChannel(channelId, newExpiry, 0);
    }

    function test_Revert_ExtendChannel_AfterSettled() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        bytes memory sig = _signClose(payerKey, channelId, deposit);
        vm.prank(payee);
        channels.closeChannel(channelId, deposit, sig);

        uint32 newExpiry = expiresAt + 7 days;

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(PaymentChannel.ChannelNotOpen.selector, channelId)
        );
        channels.extendChannel(channelId, newExpiry, 0);
    }

    // ─── Integration: Full Flow ────────────────────────────────────────────

    function test_FullFlow() public {
        uint32 expiresAt = uint32(block.timestamp + 30 days);
        uint256 deposit = 100 ether;

        // Open
        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        // Extend with top-up
        vm.prank(payer);
        channels.extendChannel(channelId, expiresAt + 30 days, 50 ether);

        assertEq(channels.getChannel(channelId).deposit, 150 ether);

        // Close with partial spend
        uint256 spent = 80 ether;
        bytes memory sig = _signClose(payerKey, channelId, spent);

        uint256 payeeBalBefore = token.balanceOf(payee);
        uint256 payerBalBefore = token.balanceOf(payer);

        vm.prank(payee);
        channels.closeChannel(channelId, spent, sig);

        assertEq(token.balanceOf(payee), payeeBalBefore + spent);
        assertEq(token.balanceOf(payer), payerBalBefore + (150 ether - spent));
    }

    function test_MultipleChannelsIndependent() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 50 ether;

        uint256 ch1 = _openChannel(payer, payee, deposit, expiresAt);
        uint256 ch2 = _openChannel(payer, other, deposit, expiresAt);

        // Close ch1 fully
        bytes memory sig1 = _signClose(payerKey, ch1, deposit);
        vm.prank(payee);
        channels.closeChannel(ch1, deposit, sig1);

        // ch2 should still be open
        PaymentChannel.Channel memory ch = channels.getChannel(ch2);
        assertEq(uint256(ch.status), uint256(PaymentChannel.Status.Open));

        // Close ch2
        bytes memory sig2 = _signClose(payerKey, ch2, deposit);
        vm.prank(other);
        channels.closeChannel(ch2, deposit, sig2);

        assertEq(channels.getChannelCount(), 2);
    }

    function test_GetChannelCount_Increments() public {
        assertEq(channels.getChannelCount(), 0);

        _openChannel(payer, payee, 10 ether, uint32(block.timestamp + 7 days));
        assertEq(channels.getChannelCount(), 1);

        _openChannel(payer, other, 10 ether, uint32(block.timestamp + 7 days));
        assertEq(channels.getChannelCount(), 2);
    }

    function test_Revert_GetChannel_NotFound() public {
        vm.expectRevert(
            abi.encodeWithSelector(PaymentChannel.ChannelNotFound.selector, 999)
        );
        channels.getChannel(999);
    }

    // ─── Short Signature ───────────────────────────────────────────────────

    function test_Revert_CloseChannel_ShortSignature() public {
        uint32 expiresAt = uint32(block.timestamp + 7 days);
        uint256 deposit = 100 ether;

        uint256 channelId = _openChannel(payer, payee, deposit, expiresAt);

        vm.prank(payee);
        vm.expectRevert();
        channels.closeChannel(channelId, deposit, hex"deadbeef");
    }
}

/// @notice Mock spending policy for testing. Always allows open; close gated by flag.
contract MockPolicy {
    bool private _allowClose;

    constructor(bool allowClose_) {
        _allowClose = allowClose_;
    }

    function validateChannelOpen(
        address, address, uint256, uint256, bytes calldata
    ) external pure returns (bool) {
        return true;
    }

    function validateChannelClose(
        address, address, uint256, uint256, bytes calldata
    ) external view returns (bool) {
        return _allowClose;
    }
}

/// @notice Mock policy that rejects all open requests
contract RejectOpenPolicy {
    function validateChannelOpen(
        address, address, uint256, uint256, bytes calldata
    ) external pure returns (bool) {
        return false;
    }

    function validateChannelClose(
        address, address, uint256, uint256, bytes calldata
    ) external pure returns (bool) {
        return true;
    }
}
