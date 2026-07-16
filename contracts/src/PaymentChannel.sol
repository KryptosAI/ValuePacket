// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {ISpendingPolicy} from "./interfaces/ISpendingPolicy.sol";

/// @title PaymentChannel
/// @notice Unidirectional payment channel for agent micropayments with EIP-712 settlement
contract PaymentChannel is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Emitted when a new payment channel is opened
    /// @param channelId   Unique channel identifier
    /// @param payer       Address that deposited funds
    /// @param payee       Address that receives payments
    /// @param token       ERC20 token used for the channel
    /// @param deposit     Total amount deposited
    /// @param expiresAt   Unix timestamp when channel expires
    event ChannelOpened(
        uint256 indexed channelId,
        address indexed payer,
        address indexed payee,
        address token,
        uint256 deposit,
        uint32 expiresAt
    );

    /// @notice Emitted when a channel is closed and settled
    /// @param channelId Unique channel identifier
    /// @param spent     Amount paid to the payee
    event ChannelClosed(uint256 indexed channelId, uint256 spent);

    /// @notice Emitted when a channel is refunded after expiry
    /// @param channelId Unique channel identifier
    event ChannelRefunded(uint256 indexed channelId);

    /// @notice Emitted when a channel is extended with additional time or deposit
    /// @param channelId         Unique channel identifier
    /// @param newExpiry         New expiration timestamp
    /// @param additionalDeposit Additional tokens deposited
    event ChannelExtended(
        uint256 indexed channelId,
        uint32 newExpiry,
        uint256 additionalDeposit
    );

    /// @notice Channel lifecycle status
    enum Status {
        Open,
        Settled,
        Refunded
    }

    /// @notice Represents a single payment channel
    struct Channel {
        address payer;
        address payee;
        address token;
        uint256 deposit;
        uint256 spent;
        uint32  openedAt;
        uint32  expiresAt;
        address policy;
        bytes   metadata;
        Status  status;
    }

    /// @notice Thrown when channel does not exist
    error ChannelNotFound(uint256 channelId);

    /// @notice Thrown when channel is not in Open status
    error ChannelNotOpen(uint256 channelId);

    /// @notice Thrown when call is not from the channel payer
    error NotPayer(uint256 channelId, address caller, address payer);

    /// @notice Thrown when call is not from the channel payee
    error NotPayee(uint256 channelId, address caller, address payee);

    /// @notice Thrown when the channel has not yet expired
    error ChannelNotExpired(uint256 channelId, uint32 expiresAt, uint32 currentTime);

    /// @notice Thrown when the spent amount exceeds the deposit
    error SpentExceedsDeposit(uint256 spent, uint256 deposit);

    /// @notice Thrown when new expiry is not later than current expiry
    error InvalidExpiry(uint32 newExpiry, uint32 currentExpiry);

    /// @notice Thrown when the policy rejects the channel operation
    error PolicyRejected(address policy);

    /// @notice Thrown when the EIP-712 signature is invalid
    error InvalidSignature();

    /// @notice Thrown when transfer fails
    error TransferFailed();

    /// @notice Thrown when deposit amount is zero
    error ZeroDeposit();

    /// @notice Thrown when token address is zero
    error ZeroToken();

    /// @notice Thrown when payee address is zero
    error ZeroPayee();

    /// @notice Thrown when expiry is in the past
    error ExpiryInPast(uint32 expiresAt, uint32 currentTime);

    // EIP-712 domain separator
    bytes32 private immutable DOMAIN_SEPARATOR;

    /// @notice EIP-712 type hash for ChannelClose
    bytes32 public constant CHANNEL_CLOSE_TYPEHASH =
        keccak256("ChannelClose(uint256 channelId,uint256 spent)");

    // Auto-incremented channel ID — starts at 1
    uint256 private _nextChannelId = 1;

    mapping(uint256 => Channel) private _channels;

    constructor() {
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

    /// @notice Open a new unidirectional payment channel
    /// @param payee     Address that receives payments
    /// @param token     ERC20 token contract address
    /// @param deposit   Total amount to deposit into the channel
    /// @param expiresAt Unix timestamp when the channel expires
    /// @param policy    Address of optional ISpendingPolicy (zero address for none)
    /// @param metadata  Arbitrary metadata passed to policy
    /// @return channelId The newly created channel's ID
    function openChannel(
        address payee,
        address token,
        uint256 deposit,
        uint32 expiresAt,
        address policy,
        bytes calldata metadata
    ) external nonReentrant returns (uint256 channelId) {
        if (payee == address(0)) revert ZeroPayee();
        if (token == address(0)) revert ZeroToken();
        if (deposit == 0) revert ZeroDeposit();
        if (expiresAt <= block.timestamp) revert ExpiryInPast(expiresAt, uint32(block.timestamp));

        if (policy != address(0)) {
            bool allowed = ISpendingPolicy(policy).validateChannelOpen(
                msg.sender, payee, deposit, expiresAt,
                abi.encode(uint256(0), metadata)
            );
            if (!allowed) revert PolicyRejected(policy);
        }

        channelId = _nextChannelId++;

        _channels[channelId] = Channel({
            payer: msg.sender,
            payee: payee,
            token: token,
            deposit: deposit,
            spent: 0,
            openedAt: uint32(block.timestamp),
            expiresAt: expiresAt,
            policy: policy,
            metadata: metadata,
            status: Status.Open
        });

        IERC20(token).safeTransferFrom(msg.sender, address(this), deposit);

        emit ChannelOpened(channelId, msg.sender, payee, token, deposit, expiresAt);
    }

    /// @notice Close and settle a channel using a payer-signed EIP-712 message
    /// @param channelId Channel to close
    /// @param spent     Amount to pay to the payee (signed by payer)
    /// @param signature EIP-712 signature from the payer over (channelId, spent)
    function closeChannel(
        uint256 channelId,
        uint256 spent,
        bytes calldata signature
    ) external nonReentrant {
        Channel storage channel = _channels[channelId];
        if (channel.payer == address(0)) revert ChannelNotFound(channelId);
        if (channel.status != Status.Open) revert ChannelNotOpen(channelId);
        if (channel.payee != msg.sender) revert NotPayee(channelId, msg.sender, channel.payee);
        if (spent > channel.deposit) revert SpentExceedsDeposit(spent, channel.deposit);

        // Verify EIP-712 signature from payer
        bytes32 structHash = keccak256(abi.encode(CHANNEL_CLOSE_TYPEHASH, channelId, spent));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = _recoverSigner(digest, signature);
        if (recovered != channel.payer) revert InvalidSignature();

        if (channel.policy != address(0)) {
            bool allowed = ISpendingPolicy(channel.policy).validateChannelClose(
                channel.payer, channel.payee, channel.deposit, spent,
                abi.encode(channel.openedAt, channel.metadata)
            );
            if (!allowed) revert PolicyRejected(channel.policy);
        }

        channel.spent = spent;
        channel.status = Status.Settled;

        uint256 refund = channel.deposit - spent;

        if (spent > 0) {
            IERC20(channel.token).safeTransfer(channel.payee, spent);
        }
        if (refund > 0) {
            IERC20(channel.token).safeTransfer(channel.payer, refund);
        }

        emit ChannelClosed(channelId, spent);
    }

    /// @notice Refund a channel after it has expired. Callable by the payer only.
    /// @param channelId Channel to refund
    function refundChannel(uint256 channelId) external nonReentrant {
        Channel storage channel = _channels[channelId];
        if (channel.payer == address(0)) revert ChannelNotFound(channelId);
        if (channel.status != Status.Open) revert ChannelNotOpen(channelId);
        if (channel.payer != msg.sender) revert NotPayer(channelId, msg.sender, channel.payer);
        if (block.timestamp <= channel.expiresAt) {
            revert ChannelNotExpired(channelId, channel.expiresAt, uint32(block.timestamp));
        }

        channel.status = Status.Refunded;

        IERC20(channel.token).safeTransfer(channel.payer, channel.deposit);

        emit ChannelRefunded(channelId);
    }

    /// @notice Extend a channel's expiry and optionally top up the deposit
    /// @param channelId         Channel to extend
    /// @param newExpiry         New expiration timestamp (must be > current expiry)
    /// @param additionalDeposit Additional tokens to deposit (can be 0)
    function extendChannel(
        uint256 channelId,
        uint32 newExpiry,
        uint256 additionalDeposit
    ) external nonReentrant {
        Channel storage channel = _channels[channelId];
        if (channel.payer == address(0)) revert ChannelNotFound(channelId);
        if (channel.status != Status.Open) revert ChannelNotOpen(channelId);
        if (channel.payer != msg.sender) revert NotPayer(channelId, msg.sender, channel.payer);
        if (newExpiry <= channel.expiresAt) {
            revert InvalidExpiry(newExpiry, channel.expiresAt);
        }

        channel.expiresAt = newExpiry;

        if (additionalDeposit > 0) {
            channel.deposit += additionalDeposit;
            IERC20(channel.token).safeTransferFrom(msg.sender, address(this), additionalDeposit);
        }

        emit ChannelExtended(channelId, newExpiry, additionalDeposit);
    }

    /// @notice Get the full channel state
    /// @param channelId Channel identifier
    /// @return Channel struct
    function getChannel(uint256 channelId) external view returns (Channel memory) {
        Channel memory channel = _channels[channelId];
        if (channel.payer == address(0)) revert ChannelNotFound(channelId);
        return channel;
    }

    /// @notice Get the total number of channels created
    /// @return Count of all channels ever created
    function getChannelCount() external view returns (uint256) {
        return _nextChannelId - 1;
    }

    /// @notice Recover the signer from an EIP-712 digest and signature
    /// @param digest    The EIP-712 message digest
    /// @param signature The signature bytes
    /// @return The recovered signer address
    function _recoverSigner(
        bytes32 digest,
        bytes memory signature
    ) internal pure returns (address) {
        return ECDSA.recover(digest, signature);
    }
}
