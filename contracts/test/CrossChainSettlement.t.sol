// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {CrossChainSettlement} from "../src/extensions/CrossChainSettlement.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract CrossChainSettlementTest is Test {
    CrossChainSettlement public settlement;
    MockERC20 public usdc;

    address public payer = address(0x100);
    address public payee = address(0x200);
    address public stranger = address(0x300);

    uint256 public payerKey = 0xA11CE;
    uint256 public payeeKey = 0xB0B;

    uint256 public constant SOURCE_CHAIN_ID = 84532;

    bytes32 public sourceDomainSeparator;

    uint256 public constant TIMEOUT = 7 days;

    event EscrowDeposited(
        bytes32 indexed paymentId,
        address indexed payer,
        address indexed payee,
        address token,
        uint256 amount,
        uint48 deadline
    );
    event EscrowSettled(bytes32 indexed paymentId, uint256 spent);
    event EscrowRefunded(bytes32 indexed paymentId);

    function setUp() public {
        payer = vm.addr(payerKey);
        payee = vm.addr(payeeKey);
        stranger = vm.addr(0xDEAD);

        usdc = new MockERC20("Mock USDC", "USDC", 6);

        address sourcePaymentChannel = address(
            0x1234567890123456789012345678901234567890
        );

        sourceDomainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ValuePacket")),
                keccak256(bytes("1")),
                SOURCE_CHAIN_ID,
                sourcePaymentChannel
            )
        );

        // The test contract itself acts as the Axelar gateway so we can call
        // _execute and settleFromSource directly from test helpers.
        settlement = new CrossChainSettlement(
            sourceDomainSeparator,
            SOURCE_CHAIN_ID,
            address(this),
            TIMEOUT
        );

        usdc.mint(payer, 1_000_000 * 10**6);
        vm.prank(payer);
        usdc.approve(address(settlement), type(uint256).max);
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    function _signClose(
        uint256 signerKey,
        uint256 channelId,
        uint256 spent
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(settlement.CHANNEL_CLOSE_TYPEHASH(), channelId, spent)
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", sourceDomainSeparator, structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _deposit(
        bytes32 paymentId,
        address _payee,
        uint256 amount
    ) internal {
        vm.prank(payer);
        settlement.deposit(paymentId, _payee, amount, address(usdc));
    }

    /// @notice Simulate Axelar GMP delivery — calls settleFromSource directly
    /// since the test contract IS the gateway (deployed with address(this))
    function _relayExecute(
        bytes32 paymentId,
        uint256 channelId,
        uint256 spent,
        bytes memory signature
    ) internal {
        settlement.settleFromSource(paymentId, channelId, spent, signature);
    }

    // ─── Deposit ────────────────────────────────────────────────────────────

    function test_Deposit() public {
        bytes32 paymentId = keccak256("payment-1");
        uint256 amount = 1000 * 10**6;

        uint256 payerBalBefore = usdc.balanceOf(payer);
        uint256 contractBalBefore = usdc.balanceOf(address(settlement));

        _deposit(paymentId, payee, amount);

        assertEq(usdc.balanceOf(payer), payerBalBefore - amount);
        assertEq(usdc.balanceOf(address(settlement)), contractBalBefore + amount);

        (
            address epayer,
            address epayee,
            address etoken,
            uint256 edeposit,
            uint256 espent,
            uint48 edeadline,
            bool esettled
        ) = settlement.escrows(paymentId);

        assertEq(epayer, payer);
        assertEq(epayee, payee);
        assertEq(etoken, address(usdc));
        assertEq(edeposit, amount);
        assertEq(espent, 0);
        assertEq(esettled, false);
        assertEq(edeadline, uint48(block.timestamp + TIMEOUT));
    }

    function test_Deposit_EmitsEvent() public {
        bytes32 paymentId = keccak256("payment-1");
        uint256 amount = 1000 * 10**6;

        vm.prank(payer);
        vm.expectEmit(true, true, true, false);
        emit EscrowDeposited(
            paymentId,
            payer,
            payee,
            address(usdc),
            amount,
            uint48(block.timestamp + TIMEOUT)
        );
        settlement.deposit(paymentId, payee, amount, address(usdc));
    }

    function test_Revert_Deposit_ZeroPayee() public {
        bytes32 paymentId = keccak256("payment-1");

        vm.prank(payer);
        vm.expectRevert(CrossChainSettlement.ZeroPayee.selector);
        settlement.deposit(paymentId, address(0), 1000 * 10**6, address(usdc));
    }

    function test_Revert_Deposit_ZeroToken() public {
        bytes32 paymentId = keccak256("payment-1");

        vm.prank(payer);
        vm.expectRevert(CrossChainSettlement.ZeroToken.selector);
        settlement.deposit(paymentId, payee, 1000 * 10**6, address(0));
    }

    function test_Revert_Deposit_ZeroAmount() public {
        bytes32 paymentId = keccak256("payment-1");

        vm.prank(payer);
        vm.expectRevert(CrossChainSettlement.ZeroDeposit.selector);
        settlement.deposit(paymentId, payee, 0, address(usdc));
    }

    function test_Revert_Deposit_DuplicatePaymentId() public {
        bytes32 paymentId = keccak256("payment-1");

        _deposit(paymentId, payee, 1000 * 10**6);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                CrossChainSettlement.EscrowAlreadySettled.selector,
                paymentId
            )
        );
        settlement.deposit(paymentId, payee, 500 * 10**6, address(usdc));
    }

    // ─── Settlement via Axelar (_execute) ───────────────────────────────────

    function test_Settle_FullSpend() public {
        bytes32 paymentId = keccak256("payment-1");
        uint256 amount = 1000 * 10**6;
        uint256 channelId = 42;

        _deposit(paymentId, payee, amount);

        bytes memory sig = _signClose(payerKey, channelId, amount);

        uint256 payeeBalBefore = usdc.balanceOf(payee);
        uint256 payerBalBefore = usdc.balanceOf(payer);

        _relayExecute(paymentId, channelId, amount, sig);

        assertEq(usdc.balanceOf(payee), payeeBalBefore + amount);
        assertEq(usdc.balanceOf(payer), payerBalBefore);

        (,,,,,, bool esettled) = settlement.escrows(paymentId);
        assertTrue(esettled);
    }

    function test_Settle_PartialSpend() public {
        bytes32 paymentId = keccak256("payment-2");
        uint256 deposit = 1000 * 10**6;
        uint256 spent = 400 * 10**6;
        uint256 channelId = 7;

        _deposit(paymentId, payee, deposit);

        bytes memory sig = _signClose(payerKey, channelId, spent);

        uint256 payeeBalBefore = usdc.balanceOf(payee);
        uint256 payerBalBefore = usdc.balanceOf(payer);

        _relayExecute(paymentId, channelId, spent, sig);

        assertEq(usdc.balanceOf(payee), payeeBalBefore + spent);
        assertEq(usdc.balanceOf(payer), payerBalBefore + (deposit - spent));
    }

    function test_Settle_EmitsEvent() public {
        bytes32 paymentId = keccak256("payment-3");
        uint256 amount = 500 * 10**6;
        uint256 channelId = 99;

        _deposit(paymentId, payee, amount);

        bytes memory sig = _signClose(payerKey, channelId, amount);

        vm.expectEmit(true, false, false, true);
        emit EscrowSettled(paymentId, amount);
        _relayExecute(paymentId, channelId, amount, sig);
    }

    function test_Settle_ViaSettleFromSource() public {
        bytes32 paymentId = keccak256("payment-direct");
        uint256 amount = 500 * 10**6;
        uint256 channelId = 1;

        _deposit(paymentId, payee, amount);

        bytes memory sig = _signClose(payerKey, channelId, amount);

        uint256 payeeBalBefore = usdc.balanceOf(payee);

        settlement.settleFromSource(paymentId, channelId, amount, sig);

        assertEq(usdc.balanceOf(payee), payeeBalBefore + amount);
    }

    function test_Revert_Settle_NotGateway() public {
        bytes32 paymentId = keccak256("payment-ng");
        uint256 amount = 500 * 10**6;
        uint256 channelId = 1;

        _deposit(paymentId, payee, amount);

        bytes memory sig = _signClose(payerKey, channelId, amount);

        vm.prank(stranger);
        vm.expectRevert(CrossChainSettlement.NotAxelarGateway.selector);
        settlement.settleFromSource(paymentId, channelId, amount, sig);
    }

    // ─── Invalid Signature ──────────────────────────────────────────────────

    function test_Revert_Settle_InvalidSignature_WrongSigner() public {
        bytes32 paymentId = keccak256("payment-sig1");
        uint256 amount = 1000 * 10**6;
        uint256 channelId = 1;

        _deposit(paymentId, payee, amount);

        bytes memory badSig = _signClose(payeeKey, channelId, amount);

        vm.expectRevert(CrossChainSettlement.InvalidSignature.selector);
        _relayExecute(paymentId, channelId, amount, badSig);
    }

    function test_Revert_Settle_InvalidSignature_WrongSpent() public {
        bytes32 paymentId = keccak256("payment-sig2");
        uint256 amount = 1000 * 10**6;
        uint256 channelId = 1;

        _deposit(paymentId, payee, amount);

        bytes memory sig = _signClose(payerKey, channelId, 500 * 10**6);

        vm.expectRevert(CrossChainSettlement.InvalidSignature.selector);
        _relayExecute(paymentId, channelId, amount, sig);
    }

    function test_Revert_Settle_InvalidSignature_WrongChannelId() public {
        bytes32 paymentId = keccak256("payment-sig3");
        uint256 amount = 1000 * 10**6;
        uint256 channelId = 1;

        _deposit(paymentId, payee, amount);

        bytes memory sig = _signClose(payerKey, 999, amount);

        vm.expectRevert(CrossChainSettlement.InvalidSignature.selector);
        _relayExecute(paymentId, channelId, amount, sig);
    }

    function test_Revert_Settle_ShortSignature() public {
        bytes32 paymentId = keccak256("payment-short");
        uint256 amount = 500 * 10**6;
        uint256 channelId = 1;

        _deposit(paymentId, payee, amount);

        vm.expectRevert(CrossChainSettlement.InvalidSignature.selector);
        _relayExecute(paymentId, channelId, amount, hex"deadbeef");
    }

    // ─── Spent Exceeds Deposit ──────────────────────────────────────────────

    function test_Revert_Settle_SpentExceedsDeposit() public {
        bytes32 paymentId = keccak256("payment-exceed");
        uint256 deposit = 500 * 10**6;
        uint256 overspend = 1000 * 10**6;
        uint256 channelId = 1;

        _deposit(paymentId, payee, deposit);

        vm.expectRevert(
            abi.encodeWithSelector(
                CrossChainSettlement.SpentExceedsDeposit.selector,
                overspend,
                deposit
            )
        );
        _relayExecute(paymentId, channelId, overspend, "");
    }

    // ─── Escrow Not Found ───────────────────────────────────────────────────

    function test_Revert_Settle_EscrowNotFound() public {
        bytes32 paymentId = keccak256("nonexistent");
        bytes memory sig = _signClose(payerKey, 1, 500 * 10**6);

        vm.expectRevert(
            abi.encodeWithSelector(
                CrossChainSettlement.EscrowNotFound.selector,
                paymentId
            )
        );
        _relayExecute(paymentId, 1, 500 * 10**6, sig);
    }

    // ─── Double Settlement ──────────────────────────────────────────────────

    function test_Revert_Settle_AlreadySettled() public {
        bytes32 paymentId = keccak256("payment-double");
        uint256 amount = 500 * 10**6;
        uint256 channelId = 1;

        _deposit(paymentId, payee, amount);

        bytes memory sig = _signClose(payerKey, channelId, amount);
        _relayExecute(paymentId, channelId, amount, sig);

        vm.expectRevert(
            abi.encodeWithSelector(
                CrossChainSettlement.EscrowAlreadySettled.selector,
                paymentId
            )
        );
        _relayExecute(paymentId, channelId, amount, sig);
    }

    // ─── Refund ─────────────────────────────────────────────────────────────

    function test_Refund_AfterTimeout() public {
        bytes32 paymentId = keccak256("payment-refund");
        uint256 amount = 1000 * 10**6;

        _deposit(paymentId, payee, amount);

        uint256 payerBalBefore = usdc.balanceOf(payer);

        vm.warp(block.timestamp + TIMEOUT + 1);

        vm.prank(payer);
        settlement.refund(paymentId);

        assertEq(usdc.balanceOf(payer), payerBalBefore + amount);

        (,,,,,, bool esettled) = settlement.escrows(paymentId);
        assertTrue(esettled);
    }

    function test_Refund_EmitsEvent() public {
        bytes32 paymentId = keccak256("payment-refund-event");
        uint256 amount = 500 * 10**6;

        _deposit(paymentId, payee, amount);

        vm.warp(block.timestamp + TIMEOUT + 1);

        vm.prank(payer);
        vm.expectEmit(true, false, false, false);
        emit EscrowRefunded(paymentId);
        settlement.refund(paymentId);
    }

    function test_Revert_Refund_TimeoutNotReached() public {
        bytes32 paymentId = keccak256("payment-refund-early");
        uint256 amount = 1000 * 10**6;

        _deposit(paymentId, payee, amount);

        vm.warp(block.timestamp + TIMEOUT - 1);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                CrossChainSettlement.TimeoutNotReached.selector,
                paymentId,
                uint48(block.timestamp + 1), // deadline
                uint48(block.timestamp)
            )
        );
        settlement.refund(paymentId);
    }

    function test_Revert_Refund_NotPayer() public {
        bytes32 paymentId = keccak256("payment-refund-notpayer");
        uint256 amount = 500 * 10**6;

        _deposit(paymentId, payee, amount);

        vm.warp(block.timestamp + TIMEOUT + 1);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                CrossChainSettlement.NotPayer.selector,
                paymentId,
                stranger,
                payer
            )
        );
        settlement.refund(paymentId);
    }

    function test_Revert_Refund_AfterSettled() public {
        bytes32 paymentId = keccak256("payment-refund-settled");
        uint256 amount = 500 * 10**6;
        uint256 channelId = 1;

        _deposit(paymentId, payee, amount);

        bytes memory sig = _signClose(payerKey, channelId, amount);
        _relayExecute(paymentId, channelId, amount, sig);

        vm.warp(block.timestamp + TIMEOUT + 1);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                CrossChainSettlement.EscrowAlreadySettled.selector,
                paymentId
            )
        );
        settlement.refund(paymentId);
    }

    function test_Revert_Refund_EscrowNotFound() public {
        bytes32 paymentId = keccak256("nonexistent-refund");

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                CrossChainSettlement.EscrowNotFound.selector,
                paymentId
            )
        );
        settlement.refund(paymentId);
    }

    // ─── Integration: Full Flow ─────────────────────────────────────────────

    function test_FullCrossChainFlow() public {
        bytes32 paymentId = keccak256("full-flow");
        uint256 deposit = 2000 * 10**6;
        uint256 spent = 1200 * 10**6;
        uint256 channelId = 88;

        _deposit(paymentId, payee, deposit);

        bytes memory sig = _signClose(payerKey, channelId, spent);

        uint256 payeeBalBefore = usdc.balanceOf(payee);
        uint256 payerBalBefore = usdc.balanceOf(payer);

        _relayExecute(paymentId, channelId, spent, sig);

        assertEq(usdc.balanceOf(payee), payeeBalBefore + spent);
        assertEq(usdc.balanceOf(payer), payerBalBefore + (deposit - spent));

        (,,,,,, bool esettled) = settlement.escrows(paymentId);
        assertTrue(esettled);
    }

    function test_MultiplePaymentsIndependent() public {
        uint256 amount = 500 * 10**6;

        bytes32 pid1 = keccak256("multi-1");
        bytes32 pid2 = keccak256("multi-2");

        _deposit(pid1, payee, amount);
        _deposit(pid2, stranger, amount);

        bytes memory sig1 = _signClose(payerKey, 10, amount);
        _relayExecute(pid1, 10, amount, sig1);

        (,,,,,, bool settled1) = settlement.escrows(pid1);
        assertTrue(settled1);

        (,,,,,, bool settled2) = settlement.escrows(pid2);
        assertFalse(settled2);

        vm.warp(block.timestamp + TIMEOUT + 1);

        uint256 payerBalBefore = usdc.balanceOf(payer);
        vm.prank(payer);
        settlement.refund(pid2);
        assertEq(usdc.balanceOf(payer), payerBalBefore + amount);
    }

    // ─── Immutable accessors ────────────────────────────────────────────────

    function test_Immutables() public {
        assertEq(settlement.SOURCE_DOMAIN_SEPARATOR(), sourceDomainSeparator);
        assertEq(settlement.SOURCE_CHAIN_ID(), SOURCE_CHAIN_ID);
        assertEq(settlement.AXELAR_GATEWAY(), address(this));
        assertEq(settlement.TIMEOUT(), TIMEOUT);
    }

    function test_ChannelCloseTypeHash() public {
        assertEq(
            settlement.CHANNEL_CLOSE_TYPEHASH(),
            keccak256("ChannelClose(uint256 channelId,uint256 spent)")
        );
    }
}
