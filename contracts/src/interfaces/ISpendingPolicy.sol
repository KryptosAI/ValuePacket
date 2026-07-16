// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISpendingPolicy
/// @notice Interface for channel spending policies
interface ISpendingPolicy {
    /// @notice Validate the opening of a new payment channel
    /// @param payer    Address funding the channel
    /// @param payee    Address receiving payments
    /// @param deposit  Total deposit amount in the channel
    /// @param expiresAt Unix timestamp when the channel expires
    /// @param metadata Arbitrary metadata for policy checks
    /// @return Whether the channel open is allowed
    function validateChannelOpen(
        address payer,
        address payee,
        uint256 deposit,
        uint256 expiresAt,
        bytes calldata metadata
    ) external returns (bool);

    /// @notice Validate the closing (settlement) of a payment channel
    /// @param payer    Address that funded the channel
    /// @param payee    Address receiving payments
    /// @param deposit  Total deposit amount in the channel
    /// @param spent    Amount being paid to payee on close
    /// @param metadata Arbitrary metadata for policy checks
    /// @return Whether the channel close is allowed
    function validateChannelClose(
        address payer,
        address payee,
        uint256 deposit,
        uint256 spent,
        bytes calldata metadata
    ) external view returns (bool);
}
