// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ServiceRegistry
/// @notice Permissionless registry where any address can list an agent service
contract ServiceRegistry {
    /// @notice Emitted when a new service is registered
    /// @param serviceId Unique identifier for the service
    /// @param provider  Address of the service provider
    event ServiceRegistered(bytes32 indexed serviceId, address indexed provider);

    /// @notice Emitted when a service is updated
    /// @param serviceId Unique identifier for the service
    event ServiceUpdated(bytes32 indexed serviceId);

    /// @notice Emitted when a service is deactivated
    /// @param serviceId Unique identifier for the service
    event ServiceDeactivated(bytes32 indexed serviceId);

    /// @notice Represents an agent service listing
    struct Service {
        address provider;
        string  metadataURI;
        uint256 pricePerRequest;
        uint32  maxResponseMs;
        uint32  registeredAt;
        bool    active;
    }

    /// @notice Thrown when attempting to register a duplicate service
    error ServiceAlreadyRegistered(bytes32 serviceId);

    /// @notice Thrown when referencing a non-existent service
    error ServiceNotFound(bytes32 serviceId);

    /// @notice Thrown when a non-provider attempts to modify a service
    error NotProvider(address caller, address provider);

    /// @notice Thrown when a service is inactive and the operation requires it active
    error ServiceInactive(bytes32 serviceId);

    /// @notice Thrown when metadataURI is empty
    error InvalidMetadataURI();

    /// @notice Thrown when price is zero
    error InvalidPrice();

    mapping(bytes32 => Service) private _services;
    bytes32[] private _serviceIndex;

    /// @notice Register a new agent service
    /// @param metadataURI    URI pointing to service metadata
    /// @param pricePerRequest Price charged per agent request (in wei)
    /// @param maxResponseMs   Maximum promised response time in milliseconds
    /// @return serviceId Unique identifier for the registered service
    function register(
        string calldata metadataURI,
        uint256 pricePerRequest,
        uint32 maxResponseMs
    ) external returns (bytes32 serviceId) {
        if (bytes(metadataURI).length == 0) revert InvalidMetadataURI();
        if (pricePerRequest == 0) revert InvalidPrice();

        serviceId = keccak256(abi.encodePacked(msg.sender, metadataURI));
        if (_services[serviceId].provider != address(0)) {
            revert ServiceAlreadyRegistered(serviceId);
        }

        _services[serviceId] = Service({
            provider: msg.sender,
            metadataURI: metadataURI,
            pricePerRequest: pricePerRequest,
            maxResponseMs: maxResponseMs,
            registeredAt: uint32(block.timestamp),
            active: true
        });

        _serviceIndex.push(serviceId);

        emit ServiceRegistered(serviceId, msg.sender);
    }

    /// @notice Update an existing service's metadata or pricing
    /// @param serviceId       Service to update
    /// @param metadataURI     New metadata URI
    /// @param pricePerRequest New price per request
    /// @param maxResponseMs   New max response time
    function updateService(
        bytes32 serviceId,
        string calldata metadataURI,
        uint256 pricePerRequest,
        uint32 maxResponseMs
    ) external {
        Service storage svc = _services[serviceId];
        if (svc.provider == address(0)) revert ServiceNotFound(serviceId);
        if (svc.provider != msg.sender) revert NotProvider(msg.sender, svc.provider);
        if (bytes(metadataURI).length == 0) revert InvalidMetadataURI();
        if (pricePerRequest == 0) revert InvalidPrice();

        svc.metadataURI = metadataURI;
        svc.pricePerRequest = pricePerRequest;
        svc.maxResponseMs = maxResponseMs;

        emit ServiceUpdated(serviceId);
    }

    /// @notice Deactivate a service so it no longer appears active
    /// @param serviceId Service to deactivate
    function deactivateService(bytes32 serviceId) external {
        Service storage svc = _services[serviceId];
        if (svc.provider == address(0)) revert ServiceNotFound(serviceId);
        if (svc.provider != msg.sender) revert NotProvider(msg.sender, svc.provider);
        if (!svc.active) revert ServiceInactive(serviceId);

        svc.active = false;

        emit ServiceDeactivated(serviceId);
    }

    /// @notice Get a service by its ID
    /// @param serviceId Service identifier
    /// @return Service struct
    function getService(bytes32 serviceId) external view returns (Service memory) {
        Service memory svc = _services[serviceId];
        if (svc.provider == address(0)) revert ServiceNotFound(serviceId);
        return svc;
    }

    /// @notice Get the total number of registered services
    /// @return count Number of services ever registered
    function getServiceCount() external view returns (uint256) {
        return _serviceIndex.length;
    }

    /// @notice Get a service ID by index (for enumeration)
    /// @param index Index in the service array
    /// @return serviceId The service ID at that index
    /// @return svc       The full Service struct
    function getServiceAtIndex(
        uint256 index
    ) external view returns (bytes32 serviceId, Service memory svc) {
        if (index >= _serviceIndex.length) revert ServiceNotFound(bytes32(0));
        serviceId = _serviceIndex[index];
        svc = _services[serviceId];
    }
}
