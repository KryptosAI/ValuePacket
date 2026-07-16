// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PaymentChannel} from "../PaymentChannel.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
    error NotPayer(uint256 subscriptionId, address caller, address payer);
    error NotPayee(uint256 subscriptionId, address caller, address payee);
    error MaxPeriodsReached(uint256 subscriptionId, uint256 completedPeriods, uint256 maxPeriods);
    error InsufficientDeposit(uint256 provided, uint256 required);
    error InvalidSignature();
    error SpentExceedsAmount(uint256 spent, uint256 amountPerPeriod);
    error ChannelNotExpired(uint256 channelId, uint32 expiresAt, uint32 currentTime);
    error ZeroAddress();
    error ZeroAmount();

    bytes32 public constant SUBSCRIPTION_AUTH_TYPEHASH =
        keccak256(
            "SubscriptionAuth(uint256 subscriptionId,uint256 amountPerPeriod,uint32 periodDuration,uint256 maxPeriods,bytes32 salt)"
        );

    mapping(uint256 => Subscription) public subscriptions;
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
        if (_recoverSigner(digest, signature) != sub.payer) revert InvalidSignature();

        paymentChannel.refundChannel(sub.activeChannelId);

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

    function cancel(uint256 subscriptionId) external nonReentrant returns (uint256 refunded) {
        Subscription storage sub = subscriptions[subscriptionId];
        if (sub.payer == address(0)) revert SubscriptionNotFound(subscriptionId);
        if (!sub.active) revert SubscriptionNotActive(subscriptionId);
        if (sub.payer != msg.sender) revert NotPayer(subscriptionId, msg.sender, sub.payer);

        sub.active = false;

        if (sub.activeChannelId != 0) {
            PaymentChannel.Channel memory channel = paymentChannel.getChannel(sub.activeChannelId);
            if (channel.status == PaymentChannel.Status.Open && block.timestamp > channel.expiresAt) {
                paymentChannel.refundChannel(sub.activeChannelId);
            }
        }

        uint256 balance = IERC20(sub.token).balanceOf(address(this));
        uint256 owed = sub.totalDeposited - sub.totalSpent;
        refunded = balance < owed ? balance : owed;

        if (refunded > 0) {
            IERC20(sub.token).safeTransfer(sub.payer, refunded);
        }

        emit SubscriptionCancelled(subscriptionId, refunded);
    }

    function getSubscription(uint256 subscriptionId) external view returns (Subscription memory) {
        Subscription memory sub = subscriptions[subscriptionId];
        if (sub.payer == address(0)) revert SubscriptionNotFound(subscriptionId);
        return sub;
    }

    function getSubscriptionCount() external view returns (uint256) {
        return _nextSubId - 1;
    }

    function _recoverSigner(bytes32 digest, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSignature();

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }

        if (v < 27) {
            v += 27;
        }

        if (v != 27 && v != 28) revert InvalidSignature();

        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();

        return signer;
    }
}
