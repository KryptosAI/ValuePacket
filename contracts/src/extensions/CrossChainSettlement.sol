// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract CrossChainSettlement {
    using SafeERC20 for IERC20;

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

    struct Escrow {
        address payer;
        address payee;
        address token;
        uint256 deposit;
        uint256 spent;
        uint48 deadline;
        bool settled;
    }

    bytes32 public immutable SOURCE_DOMAIN_SEPARATOR;
    uint256 public immutable SOURCE_CHAIN_ID;
    address public immutable AXELAR_GATEWAY;
    uint256 public immutable TIMEOUT;

    bytes32 public constant CHANNEL_CLOSE_TYPEHASH =
        keccak256("ChannelClose(uint256 channelId,uint256 spent)");

    mapping(bytes32 => Escrow) public escrows;

    error EscrowNotFound(bytes32 paymentId);
    error EscrowAlreadySettled(bytes32 paymentId);
    error NotAxelarGateway();
    error NotPayer(bytes32 paymentId, address caller, address payer);
    error SpentExceedsDeposit(uint256 spent, uint256 deposit);
    error InvalidSignature();
    error TimeoutNotReached(bytes32 paymentId, uint48 deadline, uint48 currentTime);
    error ZeroDeposit();
    error ZeroPayee();
    error ZeroToken();
    error Unauthorized();

    modifier onlyGateway() {
        if (msg.sender != AXELAR_GATEWAY) revert NotAxelarGateway();
        _;
    }

    constructor(
        bytes32 _sourceDomainSeparator,
        uint256 _sourceChainId,
        address _axelarGateway,
        uint256 _timeout
    ) {
        SOURCE_DOMAIN_SEPARATOR = _sourceDomainSeparator;
        SOURCE_CHAIN_ID = _sourceChainId;
        AXELAR_GATEWAY = _axelarGateway;
        TIMEOUT = _timeout;
    }

    function deposit(
        bytes32 paymentId,
        address payee,
        uint256 amount,
        address token
    ) external {
        if (payee == address(0)) revert ZeroPayee();
        if (token == address(0)) revert ZeroToken();
        if (amount == 0) revert ZeroDeposit();
        if (escrows[paymentId].payer != address(0)) revert EscrowAlreadySettled(paymentId);

        escrows[paymentId] = Escrow({
            payer: msg.sender,
            payee: payee,
            token: token,
            deposit: amount,
            spent: 0,
            deadline: uint48(block.timestamp) + uint48(TIMEOUT),
            settled: false
        });

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit EscrowDeposited(
            paymentId,
            msg.sender,
            payee,
            token,
            amount,
            uint48(block.timestamp) + uint48(TIMEOUT)
        );
    }

    function settleFromSource(
        bytes32 paymentId,
        uint256 channelId,
        uint256 spent,
        bytes calldata signature
    ) external onlyGateway {
        _settle(paymentId, channelId, spent, signature);
    }

    function refund(bytes32 paymentId) external {
        Escrow storage escrow = escrows[paymentId];
        if (escrow.payer == address(0)) revert EscrowNotFound(paymentId);
        if (escrow.settled) revert EscrowAlreadySettled(paymentId);
        if (msg.sender != escrow.payer) revert NotPayer(paymentId, msg.sender, escrow.payer);
        if (block.timestamp < escrow.deadline) {
            revert TimeoutNotReached(paymentId, escrow.deadline, uint48(block.timestamp));
        }

        escrow.settled = true;
        IERC20(escrow.token).safeTransfer(escrow.payer, escrow.deposit);

        emit EscrowRefunded(paymentId);
    }

    function _settle(
        bytes32 paymentId,
        uint256 channelId,
        uint256 spent,
        bytes memory signature
    ) private {
        Escrow storage escrow = escrows[paymentId];
        if (escrow.payer == address(0)) revert EscrowNotFound(paymentId);
        if (escrow.settled) revert EscrowAlreadySettled(paymentId);
        if (spent > escrow.deposit) revert SpentExceedsDeposit(spent, escrow.deposit);

        address recovered = _verifyCloseSignature(channelId, spent, signature);
        if (recovered != escrow.payer) revert InvalidSignature();

        escrow.spent = spent;
        escrow.settled = true;

        IERC20 token = IERC20(escrow.token);

        if (spent > 0) {
            token.safeTransfer(escrow.payee, spent);
        }
        uint256 refundAmount = escrow.deposit - spent;
        if (refundAmount > 0) {
            token.safeTransfer(escrow.payer, refundAmount);
        }

        emit EscrowSettled(paymentId, spent);
    }

    function _verifyCloseSignature(
        uint256 channelId,
        uint256 spent,
        bytes memory signature
    ) internal view returns (address) {
        bytes32 structHash = keccak256(
            abi.encode(CHANNEL_CLOSE_TYPEHASH, channelId, spent)
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", SOURCE_DOMAIN_SEPARATOR, structHash)
        );
        return _recoverSigner(digest, signature);
    }

    function _recoverSigner(
        bytes32 digest,
        bytes memory signature
    ) internal pure returns (address) {
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
