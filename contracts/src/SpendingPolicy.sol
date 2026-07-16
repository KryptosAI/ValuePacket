// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISpendingPolicy} from "./interfaces/ISpendingPolicy.sol";
import {ServiceRegistry} from "./ServiceRegistry.sol";

/// @title SpendingPolicy
/// @notice Reference implementation of ISpendingPolicy for agent payment channels
contract SpendingPolicy is ISpendingPolicy {
    /// @notice Emitted when a user sets or updates their policy configuration
    /// @param user The user whose policy was updated
    event PolicySet(address indexed user);

    /// @notice Emitted when an allowed service is added for a user
    /// @param user      The user
    /// @param serviceId The service ID added
    event AllowedServiceAdded(address indexed user, bytes32 indexed serviceId);

    /// @notice Emitted when an allowed service is removed for a user
    /// @param user      The user
    /// @param serviceId The service ID removed
    event AllowedServiceRemoved(address indexed user, bytes32 indexed serviceId);

    /// @notice Emitted when an allowed provider is added for a user
    /// @param user     The user
    /// @param provider The provider address added
    event AllowedProviderAdded(address indexed user, address indexed provider);

    /// @notice Emitted when an allowed provider is removed for a user
    /// @param user     The user
    /// @param provider The provider address removed
    event AllowedProviderRemoved(address indexed user, address indexed provider);

    /// @notice Per-user spending policy configuration
    struct PolicyConfig {
        uint256 maxSpendPerDay;
        uint256 maxChannelDeposit;
        uint256 maxChannelDuration;
        bool    requireRegisteredService;
        bool    active;
    }

    /// @notice Thrown when deposit exceeds the user's max channel deposit
    error DepositTooHigh(uint256 deposit, uint256 maxDeposit);

    /// @notice Thrown when channel duration exceeds the user's max duration
    error DurationTooLong(uint256 duration, uint256 maxDuration);

    /// @notice Thrown when spending exceeds the daily limit
    error SpendTooHigh(uint256 spent, uint256 maxSpendForPeriod);

    /// @notice Thrown when a required service is not registered in the ServiceRegistry
    error ServiceNotRegistered(bytes32 serviceId);

    /// @notice Thrown when the payee has no active service in the ServiceRegistry
    error PayeeNotRegistered(address payee);

    /// @notice Thrown when user's policy is not active
    error PolicyNotActive(address user);

    /// @notice Thrown when service is already in the allowed list
    error ServiceAlreadyAllowed(bytes32 serviceId);

    /// @notice Thrown when service is not in the allowed list
    error ServiceNotAllowed(bytes32 serviceId);

    /// @notice Thrown when provider is already in the allowed list
    error ProviderAlreadyAllowed(address provider);

    /// @notice Thrown when provider is not in the allowed list
    error ProviderNotAllowed(address provider);

    /// @notice Reference to the ServiceRegistry contract
    ServiceRegistry public immutable serviceRegistry;

    /// @notice Per-user policy configuration
    mapping(address => PolicyConfig) public policies;

    /// @notice Per-user list of allowed service IDs
    mapping(address => bytes32[]) public allowedServices;

    /// @notice Per-user list of allowed provider addresses
    mapping(address => address[]) public allowedProviders;

    /// @dev Internal mapping to quickly check allowed services per user
    mapping(address => mapping(bytes32 => bool)) private _isServiceAllowed;

    /// @dev Internal mapping to quickly check allowed providers per user
    mapping(address => mapping(address => bool)) private _isProviderAllowed;

    constructor(address _serviceRegistry) {
        serviceRegistry = ServiceRegistry(_serviceRegistry);
    }

    /// @notice Set or update the spending policy for the caller
    /// @param maxSpendPerDay          Maximum tokens that can be spent per day
    /// @param maxChannelDeposit       Maximum single channel deposit
    /// @param maxChannelDuration      Maximum channel lifetime in seconds
    /// @param requireRegisteredService Whether payees must be registered in ServiceRegistry
    function setPolicy(
        uint256 maxSpendPerDay,
        uint256 maxChannelDeposit,
        uint256 maxChannelDuration,
        bool requireRegisteredService
    ) external {
        policies[msg.sender] = PolicyConfig({
            maxSpendPerDay: maxSpendPerDay,
            maxChannelDeposit: maxChannelDeposit,
            maxChannelDuration: maxChannelDuration,
            requireRegisteredService: requireRegisteredService,
            active: true
        });

        emit PolicySet(msg.sender);
    }

    /// @notice Add a service to the user's allowed services list
    /// @param serviceId Service identifier from ServiceRegistry
    function addAllowedService(bytes32 serviceId) external {
        if (_isServiceAllowed[msg.sender][serviceId]) {
            revert ServiceAlreadyAllowed(serviceId);
        }

        _isServiceAllowed[msg.sender][serviceId] = true;
        allowedServices[msg.sender].push(serviceId);

        emit AllowedServiceAdded(msg.sender, serviceId);
    }

    /// @notice Remove a service from the user's allowed services list
    /// @param serviceId Service identifier to remove
    function removeAllowedService(bytes32 serviceId) external {
        if (!_isServiceAllowed[msg.sender][serviceId]) {
            revert ServiceNotAllowed(serviceId);
        }

        _isServiceAllowed[msg.sender][serviceId] = false;

        bytes32[] storage list = allowedServices[msg.sender];
        uint256 len = list.length;
        for (uint256 i = 0; i < len; i++) {
            if (list[i] == serviceId) {
                list[i] = list[len - 1];
                list.pop();
                break;
            }
        }

        emit AllowedServiceRemoved(msg.sender, serviceId);
    }

    /// @notice Add a provider to the user's allowed providers list
    /// @param provider Provider address to allow
    function addAllowedProvider(address provider) external {
        if (_isProviderAllowed[msg.sender][provider]) {
            revert ProviderAlreadyAllowed(provider);
        }

        _isProviderAllowed[msg.sender][provider] = true;
        allowedProviders[msg.sender].push(provider);

        emit AllowedProviderAdded(msg.sender, provider);
    }

    /// @notice Remove a provider from the user's allowed providers list
    /// @param provider Provider address to remove
    function removeAllowedProvider(address provider) external {
        if (!_isProviderAllowed[msg.sender][provider]) {
            revert ProviderNotAllowed(provider);
        }

        _isProviderAllowed[msg.sender][provider] = false;

        address[] storage list = allowedProviders[msg.sender];
        uint256 len = list.length;
        for (uint256 i = 0; i < len; i++) {
            if (list[i] == provider) {
                list[i] = list[len - 1];
                list.pop();
                break;
            }
        }

        emit AllowedProviderRemoved(msg.sender, provider);
    }

    /// @notice Validate a channel open against the payer's policy
    /// @inheritdoc ISpendingPolicy
    function validateChannelOpen(
        address payer,
        address payee,
        uint256 deposit,
        uint256 expiresAt,
        bytes calldata
    ) external view returns (bool) {
        PolicyConfig storage cfg = policies[payer];
        if (!cfg.active) return true;

        if (cfg.maxChannelDeposit > 0 && deposit > cfg.maxChannelDeposit) {
            revert DepositTooHigh(deposit, cfg.maxChannelDeposit);
        }

        uint256 duration = expiresAt - block.timestamp;
        if (cfg.maxChannelDuration > 0 && duration > cfg.maxChannelDuration) {
            revert DurationTooLong(duration, cfg.maxChannelDuration);
        }

        if (cfg.requireRegisteredService) {
            uint256 count = serviceRegistry.getServiceCount();
            bool found = false;
            for (uint256 i = 0; i < count; i++) {
                (, ServiceRegistry.Service memory svc) = serviceRegistry.getServiceAtIndex(i);
                if (svc.provider == payee && svc.active) {
                    found = true;
                    break;
                }
            }
            if (!found) revert PayeeNotRegistered(payee);
        }

        return true;
    }

    /// @notice Validate a channel close against the payer's policy
    /// @inheritdoc ISpendingPolicy
    function validateChannelClose(
        address payer,
        address payee,
        uint256 deposit,
        uint256 spent,
        bytes calldata metadata
    ) external view returns (bool) {
        PolicyConfig storage cfg = policies[payer];
        if (!cfg.active) return true;

        address[] storage providers = allowedProviders[payer];
        if (providers.length > 0 && !_isProviderAllowed[payer][payee]) {
            revert ProviderNotAllowed(payee);
        }

        uint256 channelOpenedAt = _decodeOpenedAt(metadata);

        if (cfg.maxSpendPerDay > 0) {
            uint256 elapsedDays = 1;
            if (channelOpenedAt > 0 && block.timestamp > channelOpenedAt) {
                elapsedDays = ((block.timestamp - channelOpenedAt) / 1 days) + 1;
            }
            uint256 maxSpendForPeriod = cfg.maxSpendPerDay * elapsedDays;
            if (spent > maxSpendForPeriod) {
                revert SpendTooHigh(spent, maxSpendForPeriod);
            }
        }

        return true;
    }

    /// @notice Get the count of allowed services for a user
    /// @param user The user address
    /// @return Number of allowed services
    function getAllowedServiceCount(address user) external view returns (uint256) {
        return allowedServices[user].length;
    }

    /// @notice Get the count of allowed providers for a user
    /// @param user The user address
    /// @return Number of allowed providers
    function getAllowedProviderCount(address user) external view returns (uint256) {
        return allowedProviders[user].length;
    }

    /// @dev Decode the channel openedAt timestamp from metadata (first 32 bytes)
    function _decodeOpenedAt(bytes calldata metadata) internal pure returns (uint256) {
        if (metadata.length < 32) return 0;
        return uint256(bytes32(metadata[:32]));
    }
}
