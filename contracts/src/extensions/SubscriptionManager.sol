// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PaymentChannel} from "../PaymentChannel.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title SubscriptionManager
/// @notice Recurring payments built on top of PaymentChannel: one channel per billing period,
///         renewed by the payee with a payer-signed, period-bound EIP-712 authorization.
/// @dev Deliberate MVP limitations (accepted design tradeoffs, see README "Design limitations"):
///      - No pause mechanism: there is no emergency stop; funds move only via the flows below.
///      - No upgradeability: the contract is immutable once deployed.
///      - Gas is not reimbursed: payees pay gas for renew(), payers for cancel(), and anyone
///        may pay gas for sweepCancelledSubscription().
///      Escrow accounting is per-subscription (heldBalance): the manager never refunds one
///      subscription out of tokens attributable to another. Invariant: the manager's token
///      balance is always >= the sum of all subscriptions' held balances (channel deposits
///      are held by PaymentChannel, not counted in heldBalance).
contract SubscriptionManager is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Subscription {
        address payer;
        address payee;
        address token;
        uint256 amountPerPeriod;
        uint32  periodDuration;
        uint256 maxPeriods;
        uint256 completedPeriods;
        uint256 totalDeposited;
        uint256 totalSpent;
        uint256 activeChannelId;
        uint32  currentPeriodStart;
        bool    active;
        bytes   metadata;
    }

    error SubscriptionNotFound(uint256 subscriptionId);
    error SubscriptionNotActive(uint256 subscriptionId);
    error SubscriptionStillActive(uint256 subscriptionId);
    error NotPayer(uint256 subscriptionId, address caller, address payer);
    error NotPayee(uint256 subscriptionId, address caller, address payee);
    error MaxPeriodsReached(uint256 subscriptionId, uint256 completedPeriods, uint256 maxPeriods);
    error InsufficientDeposit(uint256 provided, uint256 required);
    error InvalidSignature();
    error InvalidSalt(bytes32 provided, bytes32 expected);
    error SpentExceedsAmount(uint256 spent, uint256 amountPerPeriod);
    error ChannelNotExpired(uint256 channelId, uint32 expiresAt, uint32 currentTime);
    error NothingToSweep(uint256 subscriptionId);
    error ZeroAddress();
    error ZeroAmount();

    bytes32 public constant SUBSCRIPTION_AUTH_TYPEHASH =
        keccak256(
            "SubscriptionAuth(uint256 subscriptionId,uint256 amountPerPeriod,uint32 periodDuration,uint256 maxPeriods,bytes32 salt)"
        );

    mapping(uint256 => Subscription) public subscriptions;

    /// @notice Tokens currently held by this contract on behalf of a subscription,
    ///         excluding amounts locked inside the subscription's active PaymentChannel.
    mapping(uint256 => uint256) public heldBalance;

    uint256 private _nextSubId = 1;
    PaymentChannel public immutable paymentChannel;

    bytes32 private immutable DOMAIN_SEPARATOR;

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
    event SubscriptionSwept(uint256 indexed subscriptionId, uint256 amount);

    constructor(PaymentChannel _paymentChannel) {
        paymentChannel = _paymentChannel;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ValuePacket")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function createSubscription(
        address payee,
        address token,
        uint256 amountPerPeriod,
        uint32 periodDuration,
        uint256 maxPeriods,
        uint256 initialDeposit,
        bytes calldata metadata
    ) external nonReentrant returns (uint256 subscriptionId) {
        if (payee == address(0)) revert ZeroAddress();
        if (token == address(0)) revert ZeroAddress();
        if (amountPerPeriod == 0) revert ZeroAmount();
        if (initialDeposit < amountPerPeriod) {
            revert InsufficientDeposit(initialDeposit, amountPerPeriod);
        }

        subscriptionId = _nextSubId++;

        uint32 expiresAt = uint32(block.timestamp) + periodDuration;

        IERC20(token).safeTransferFrom(msg.sender, address(this), initialDeposit);
        IERC20(token).forceApprove(address(paymentChannel), amountPerPeriod);

        uint256 channelId = paymentChannel.openChannel(
            payee, token, amountPerPeriod, expiresAt, address(0), metadata
        );

        // amountPerPeriod is locked in the channel; the rest is held per-subscription.
        heldBalance[subscriptionId] = initialDeposit - amountPerPeriod;

        subscriptions[subscriptionId] = Subscription({
            payer: msg.sender,
            payee: payee,
            token: token,
            amountPerPeriod: amountPerPeriod,
            periodDuration: periodDuration,
            maxPeriods: maxPeriods,
            completedPeriods: 0,
            totalDeposited: initialDeposit,
            totalSpent: 0,
            activeChannelId: channelId,
            currentPeriodStart: uint32(block.timestamp),
            active: true,
            metadata: metadata
        });

        emit SubscriptionCreated(subscriptionId, msg.sender, payee, amountPerPeriod);
    }

    /// @notice Settle the just-finished period and open the channel for the next one.
    /// @dev The salt in the payer's SubscriptionAuth signature MUST be period-bound:
    ///      keccak256(abi.encode(subscriptionId, completedPeriods + 1)). This makes each
    ///      signature valid for exactly one renewal, preventing the payee from replaying
    ///      a single authorization across every remaining period.
    function renew(
        uint256 subscriptionId,
        uint256 spent,
        bytes32 salt,
        bytes calldata signature
    ) external nonReentrant {
        Subscription storage sub = subscriptions[subscriptionId];
        if (sub.payer == address(0)) revert SubscriptionNotFound(subscriptionId);
        if (!sub.active) revert SubscriptionNotActive(subscriptionId);
        if (sub.payee != msg.sender) revert NotPayee(subscriptionId, msg.sender, sub.payee);
        if (sub.maxPeriods > 0 && sub.completedPeriods >= sub.maxPeriods) {
            revert MaxPeriodsReached(subscriptionId, sub.completedPeriods, sub.maxPeriods);
        }
        if (spent > sub.amountPerPeriod) revert SpentExceedsAmount(spent, sub.amountPerPeriod);

        bytes32 expectedSalt = keccak256(abi.encode(subscriptionId, sub.completedPeriods + 1));
        if (salt != expectedSalt) revert InvalidSalt(salt, expectedSalt);

        bytes32 structHash = keccak256(
            abi.encode(
                SUBSCRIPTION_AUTH_TYPEHASH,
                subscriptionId,
                sub.amountPerPeriod,
                sub.periodDuration,
                sub.maxPeriods,
                salt
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        if (ECDSA.recover(digest, signature) != sub.payer) revert InvalidSignature();

        // Returns the expired channel's deposit (amountPerPeriod) to this contract.
        paymentChannel.refundChannel(sub.activeChannelId);

        uint256 available = heldBalance[subscriptionId] + sub.amountPerPeriod;
        uint256 required = spent + sub.amountPerPeriod;
        if (available < required) revert InsufficientDeposit(available, required);
        heldBalance[subscriptionId] = available - required;

        sub.totalSpent += spent;
        sub.completedPeriods++;
        if (spent > 0) {
            IERC20(sub.token).safeTransfer(sub.payee, spent);
        }

        uint32 newExpiresAt = uint32(block.timestamp) + sub.periodDuration;
        IERC20(sub.token).forceApprove(address(paymentChannel), sub.amountPerPeriod);

        uint256 newChannelId = paymentChannel.openChannel(
            sub.payee, sub.token, sub.amountPerPeriod, newExpiresAt, address(0), sub.metadata
        );

        sub.activeChannelId = newChannelId;
        sub.currentPeriodStart = uint32(block.timestamp);

        emit SubscriptionRenewed(subscriptionId, newChannelId, spent, sub.completedPeriods);
    }

    /// @notice Cancel a subscription and refund the payer from THIS subscription's funds only.
    /// @dev Refunds the subscription's own held balance plus the active channel's deposit
    ///      when that channel is refundable (Open and expired). If the active channel is
    ///      still Open and not yet expired, its deposit stays in PaymentChannel until it
    ///      expires or the payee closes it; call sweepCancelledSubscription() afterwards
    ///      to return the remainder to the payer. Never touches funds attributable to
    ///      other subscriptions.
    function cancel(uint256 subscriptionId) external nonReentrant returns (uint256 refunded) {
        Subscription storage sub = subscriptions[subscriptionId];
        if (sub.payer == address(0)) revert SubscriptionNotFound(subscriptionId);
        if (!sub.active) revert SubscriptionNotActive(subscriptionId);
        if (sub.payer != msg.sender) revert NotPayer(subscriptionId, msg.sender, sub.payer);

        sub.active = false;

        refunded = heldBalance[subscriptionId];
        heldBalance[subscriptionId] = 0;

        if (sub.activeChannelId != 0) {
            PaymentChannel.Channel memory channel = paymentChannel.getChannel(sub.activeChannelId);
            if (channel.status == PaymentChannel.Status.Open && block.timestamp > channel.expiresAt) {
                paymentChannel.refundChannel(sub.activeChannelId);
                refunded += channel.deposit;
                sub.activeChannelId = 0;
            }
        }

        if (refunded > 0) {
            IERC20(sub.token).safeTransfer(sub.payer, refunded);
        }

        emit SubscriptionCancelled(subscriptionId, refunded);
    }

    /// @notice After a subscription is cancelled, collect the remainder of its last channel
    ///         (once that channel has expired or been closed by the payee) and send it to
    ///         the payer. Callable by anyone.
    /// @param subscriptionId The cancelled subscription to sweep
    /// @return swept Amount transferred to the payer
    function sweepCancelledSubscription(
        uint256 subscriptionId
    ) external nonReentrant returns (uint256 swept) {
        Subscription storage sub = subscriptions[subscriptionId];
        if (sub.payer == address(0)) revert SubscriptionNotFound(subscriptionId);
        if (sub.active) revert SubscriptionStillActive(subscriptionId);

        uint256 channelId = sub.activeChannelId;
        if (channelId == 0) revert NothingToSweep(subscriptionId);

        PaymentChannel.Channel memory channel = paymentChannel.getChannel(channelId);

        if (channel.status == PaymentChannel.Status.Open) {
            if (block.timestamp <= channel.expiresAt) {
                revert ChannelNotExpired(channelId, channel.expiresAt, uint32(block.timestamp));
            }
            paymentChannel.refundChannel(channelId);
            swept = channel.deposit;
        } else if (channel.status == PaymentChannel.Status.Settled) {
            // Payee closed the channel: PaymentChannel already returned deposit - spent
            // to this contract at close time; forward that remainder to the payer.
            swept = channel.deposit - channel.spent;
        } else {
            revert NothingToSweep(subscriptionId);
        }

        sub.activeChannelId = 0;

        if (swept > 0) {
            IERC20(sub.token).safeTransfer(sub.payer, swept);
        }

        emit SubscriptionSwept(subscriptionId, swept);
    }

    function getSubscription(uint256 subscriptionId) external view returns (Subscription memory) {
        Subscription memory sub = subscriptions[subscriptionId];
        if (sub.payer == address(0)) revert SubscriptionNotFound(subscriptionId);
        return sub;
    }

    function getSubscriptionCount() external view returns (uint256) {
        return _nextSubId - 1;
    }
}
