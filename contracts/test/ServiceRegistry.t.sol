// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ServiceRegistry} from "../src/ServiceRegistry.sol";

contract ServiceRegistryTest is Test {
    ServiceRegistry public registry;

    address public provider1 = address(0x100);
    address public provider2 = address(0x200);

    event ServiceRegistered(bytes32 indexed serviceId, address indexed provider);
    event ServiceUpdated(bytes32 indexed serviceId);
    event ServiceDeactivated(bytes32 indexed serviceId);

    function setUp() public {
        registry = new ServiceRegistry();
    }

    function test_Register() public {
        vm.prank(provider1);
        bytes32 serviceId = registry.register("ipfs://service1", 1 ether, 5000);

        assertEq(registry.getServiceCount(), 1);

        ServiceRegistry.Service memory svc = registry.getService(serviceId);
        assertEq(svc.provider, provider1);
        assertEq(svc.metadataURI, "ipfs://service1");
        assertEq(svc.pricePerRequest, 1 ether);
        assertEq(svc.maxResponseMs, 5000);
        assertTrue(svc.active);
        assertTrue(svc.registeredAt > 0);
    }

    function test_Register_EmitsEvent() public {
        vm.prank(provider1);
        bytes32 expectedId = keccak256(abi.encodePacked(provider1, "ipfs://service1"));

        vm.expectEmit(true, true, false, false);
        emit ServiceRegistered(expectedId, provider1);
        registry.register("ipfs://service1", 1 ether, 5000);
    }

    function test_Revert_DuplicateRegister() public {
        vm.prank(provider1);
        registry.register("ipfs://service1", 1 ether, 5000);

        vm.prank(provider1);
        vm.expectRevert(
            abi.encodeWithSelector(
                ServiceRegistry.ServiceAlreadyRegistered.selector,
                keccak256(abi.encodePacked(provider1, "ipfs://service1"))
            )
        );
        registry.register("ipfs://service1", 1 ether, 5000);
    }

    function test_Revert_EmptyMetadata() public {
        vm.prank(provider1);
        vm.expectRevert(ServiceRegistry.InvalidMetadataURI.selector);
        registry.register("", 1 ether, 5000);
    }

    function test_Revert_ZeroPrice() public {
        vm.prank(provider1);
        vm.expectRevert(ServiceRegistry.InvalidPrice.selector);
        registry.register("ipfs://service1", 0, 5000);
    }

    function test_UpdateService() public {
        vm.prank(provider1);
        bytes32 serviceId = registry.register("ipfs://service1", 1 ether, 5000);

        vm.prank(provider1);
        registry.updateService(serviceId, "ipfs://updated", 2 ether, 10000);

        ServiceRegistry.Service memory svc = registry.getService(serviceId);
        assertEq(svc.metadataURI, "ipfs://updated");
        assertEq(svc.pricePerRequest, 2 ether);
        assertEq(svc.maxResponseMs, 10000);
        assertEq(svc.provider, provider1);
    }

    function test_UpdateService_EmitsEvent() public {
        vm.prank(provider1);
        bytes32 serviceId = registry.register("ipfs://service1", 1 ether, 5000);

        vm.prank(provider1);
        vm.expectEmit(true, false, false, false);
        emit ServiceUpdated(serviceId);
        registry.updateService(serviceId, "ipfs://updated", 2 ether, 10000);
    }

    function test_Revert_UpdateNotProvider() public {
        vm.prank(provider1);
        bytes32 serviceId = registry.register("ipfs://service1", 1 ether, 5000);

        vm.prank(provider2);
        vm.expectRevert(
            abi.encodeWithSelector(
                ServiceRegistry.NotProvider.selector,
                provider2,
                provider1
            )
        );
        registry.updateService(serviceId, "ipfs://updated", 2 ether, 10000);
    }

    function test_Revert_UpdateNotFound() public {
        bytes32 fakeId = keccak256(abi.encodePacked(address(0x999), "nonexistent"));

        vm.prank(address(0x999));
        vm.expectRevert(
            abi.encodeWithSelector(ServiceRegistry.ServiceNotFound.selector, fakeId)
        );
        registry.updateService(fakeId, "ipfs://updated", 2 ether, 10000);
    }

    function test_Revert_UpdateEmptyMetadata() public {
        vm.prank(provider1);
        bytes32 serviceId = registry.register("ipfs://service1", 1 ether, 5000);

        vm.prank(provider1);
        vm.expectRevert(ServiceRegistry.InvalidMetadataURI.selector);
        registry.updateService(serviceId, "", 2 ether, 10000);
    }

    function test_Revert_UpdateZeroPrice() public {
        vm.prank(provider1);
        bytes32 serviceId = registry.register("ipfs://service1", 1 ether, 5000);

        vm.prank(provider1);
        vm.expectRevert(ServiceRegistry.InvalidPrice.selector);
        registry.updateService(serviceId, "ipfs://updated", 0, 10000);
    }

    function test_DeactivateService() public {
        vm.prank(provider1);
        bytes32 serviceId = registry.register("ipfs://service1", 1 ether, 5000);

        vm.prank(provider1);
        registry.deactivateService(serviceId);

        ServiceRegistry.Service memory svc = registry.getService(serviceId);
        assertFalse(svc.active);
    }

    function test_DeactivateService_EmitsEvent() public {
        vm.prank(provider1);
        bytes32 serviceId = registry.register("ipfs://service1", 1 ether, 5000);

        vm.prank(provider1);
        vm.expectEmit(true, false, false, false);
        emit ServiceDeactivated(serviceId);
        registry.deactivateService(serviceId);
    }

    function test_Revert_DeactivateNotProvider() public {
        vm.prank(provider1);
        bytes32 serviceId = registry.register("ipfs://service1", 1 ether, 5000);

        vm.prank(provider2);
        vm.expectRevert(
            abi.encodeWithSelector(
                ServiceRegistry.NotProvider.selector,
                provider2,
                provider1
            )
        );
        registry.deactivateService(serviceId);
    }

    function test_Revert_DeactivateAlreadyInactive() public {
        vm.prank(provider1);
        bytes32 serviceId = registry.register("ipfs://service1", 1 ether, 5000);

        vm.prank(provider1);
        registry.deactivateService(serviceId);

        vm.prank(provider1);
        vm.expectRevert(
            abi.encodeWithSelector(ServiceRegistry.ServiceInactive.selector, serviceId)
        );
        registry.deactivateService(serviceId);
    }

    function test_GetServiceNotFound() public {
        bytes32 fakeId = keccak256(abi.encodePacked(address(0x999), "nonexistent"));
        vm.expectRevert(
            abi.encodeWithSelector(ServiceRegistry.ServiceNotFound.selector, fakeId)
        );
        registry.getService(fakeId);
    }

    function test_Enumeration() public {
        vm.prank(provider1);
        bytes32 id1 = registry.register("ipfs://s1", 1 ether, 5000);
        vm.prank(provider2);
        bytes32 id2 = registry.register("ipfs://s2", 2 ether, 6000);

        assertEq(registry.getServiceCount(), 2);

        (bytes32 svcId0, ServiceRegistry.Service memory svc0) = registry.getServiceAtIndex(0);
        assertEq(svcId0, id1);
        assertEq(svc0.provider, provider1);

        (bytes32 svcId1, ServiceRegistry.Service memory svc1) = registry.getServiceAtIndex(1);
        assertEq(svcId1, id2);
        assertEq(svc1.provider, provider2);
    }

    function test_Revert_GetServiceAtIndexOutOfBounds() public {
        vm.expectRevert(
            abi.encodeWithSelector(ServiceRegistry.ServiceNotFound.selector, bytes32(0))
        );
        registry.getServiceAtIndex(0);
    }

    function test_MultipleRegistrationsSameProviderDifferentMetadata() public {
        vm.startPrank(provider1);
        bytes32 id1 = registry.register("ipfs://s1", 1 ether, 5000);
        bytes32 id2 = registry.register("ipfs://s2", 2 ether, 6000);
        vm.stopPrank();

        assertEq(registry.getServiceCount(), 2);
        assertTrue(id1 != id2);

        ServiceRegistry.Service memory svc1 = registry.getService(id1);
        assertEq(svc1.metadataURI, "ipfs://s1");

        ServiceRegistry.Service memory svc2 = registry.getService(id2);
        assertEq(svc2.metadataURI, "ipfs://s2");
    }

    function test_ServiceIdDeterministic() public {
        bytes32 expectedId = keccak256(abi.encodePacked(provider1, "ipfs://test"));

        vm.prank(provider1);
        bytes32 actualId = registry.register("ipfs://test", 1 ether, 5000);

        assertEq(actualId, expectedId);
    }

    function test_RegisteredServicePersistsAfterUpdate() public {
        vm.prank(provider1);
        bytes32 serviceId = registry.register("ipfs://service1", 1 ether, 5000);

        vm.prank(provider1);
        registry.updateService(serviceId, "ipfs://updated", 3 ether, 8000);

        assertEq(registry.getServiceCount(), 1);

        ServiceRegistry.Service memory svc = registry.getService(serviceId);
        assertTrue(svc.active);
        assertEq(svc.provider, provider1);
    }
}
