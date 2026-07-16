// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {SpendingPolicy} from "../src/SpendingPolicy.sol";
import {ServiceRegistry} from "../src/ServiceRegistry.sol";

contract SpendingPolicyTest is Test {
    SpendingPolicy public policy;
    ServiceRegistry public registry;

    address public payer = address(0x100);
    address public payee = address(0x200);
    address public other = address(0x300);

    event PolicySet(address indexed user);
    event AllowedServiceAdded(address indexed user, bytes32 indexed serviceId);
    event AllowedServiceRemoved(address indexed user, bytes32 indexed serviceId);
    event AllowedProviderAdded(address indexed user, address indexed provider);
    event AllowedProviderRemoved(address indexed user, address indexed provider);

    function setUp() public {
        registry = new ServiceRegistry();
        policy = new SpendingPolicy(address(registry));
    }

    // ─── Policy Configuration ──────────────────────────────────────────────

    function test_SetPolicy() public {
        vm.prank(payer);
        policy.setPolicy(100 ether, 50 ether, 7 days, false);

        (
            uint256 maxSpendPerDay,
            uint256 maxChannelDeposit,
            uint256 maxChannelDuration,
            bool requireRegisteredService,
            bool active
        ) = policy.policies(payer);

        assertEq(maxSpendPerDay, 100 ether);
        assertEq(maxChannelDeposit, 50 ether);
        assertEq(maxChannelDuration, 7 days);
        assertFalse(requireRegisteredService);
        assertTrue(active);
    }

    function test_SetPolicy_EmitsEvent() public {
        vm.prank(payer);
        vm.expectEmit(true, false, false, false);
        emit PolicySet(payer);
        policy.setPolicy(100 ether, 50 ether, 7 days, false);
    }

    function test_SetPolicy_CanUpdate() public {
        vm.startPrank(payer);
        policy.setPolicy(100 ether, 50 ether, 7 days, false);

        policy.setPolicy(200 ether, 75 ether, 14 days, true);

        (uint256 maxSpendPerDay,,, bool requireRegisteredService,) = policy.policies(payer);
        assertEq(maxSpendPerDay, 200 ether);
        assertTrue(requireRegisteredService);
        vm.stopPrank();
    }

    function test_NoPolicy_AllowsAll() public {
        // Payer has no policy set — validateChannelOpen returns true
        bool result = policy.validateChannelOpen(
            payer, payee, 1000 ether, uint32(block.timestamp + 30 days), abi.encode(uint256(0), "")
        );
        assertTrue(result);
    }

    // ─── validateChannelOpen: Deposit Limit ────────────────────────────────

    function test_ValidateChannelOpen_DepositLimit() public {
        vm.prank(payer);
        policy.setPolicy(0, 10 ether, 0, false);

        // Under limit
        bool result = policy.validateChannelOpen(
            payer, payee, 10 ether, uint32(block.timestamp + 1 days), abi.encode(uint256(0), "")
        );
        assertTrue(result);

        // Over limit
        vm.expectRevert(
            abi.encodeWithSelector(SpendingPolicy.DepositTooHigh.selector, 11 ether, 10 ether)
        );
        policy.validateChannelOpen(
            payer, payee, 11 ether, uint32(block.timestamp + 1 days), abi.encode(uint256(0), "")
        );
    }

    function test_ValidateChannelOpen_ZeroMaxDepositSkips() public {
        vm.prank(payer);
        policy.setPolicy(0, 0, 0, false);

        // No limit set — should pass
        bool result = policy.validateChannelOpen(
            payer, payee, 10000 ether, uint32(block.timestamp + 1 days), abi.encode(uint256(0), "")
        );
        assertTrue(result);
    }

    // ─── validateChannelOpen: Duration Limit ───────────────────────────────

    function test_ValidateChannelOpen_DurationLimit() public {
        vm.warp(1 days);

        vm.prank(payer);
        policy.setPolicy(0, 0, 7 days, false);

        // Under limit: duration = 7 days
        bool result = policy.validateChannelOpen(
            payer, payee, 1 ether, uint32(block.timestamp + 7 days), abi.encode(uint256(0), "")
        );
        assertTrue(result);

        // Over limit: duration = 8 days + 1 second
        uint32 overExpiry = uint32(block.timestamp + 8 days + 1);
        uint256 expectedDuration = uint256(overExpiry) - block.timestamp;
        vm.expectRevert(
            abi.encodeWithSelector(
                SpendingPolicy.DurationTooLong.selector,
                expectedDuration,
                7 days
            )
        );
        policy.validateChannelOpen(
            payer, payee, 1 ether, overExpiry, abi.encode(uint256(0), "")
        );
    }

    function test_ValidateChannelOpen_ZeroMaxDurationSkips() public {
        vm.prank(payer);
        policy.setPolicy(0, 0, 0, false);

        bool result = policy.validateChannelOpen(
            payer, payee, 1 ether, uint32(block.timestamp + 365 days), abi.encode(uint256(0), "")
        );
        assertTrue(result);
    }

    // ─── validateChannelClose: Spend Limit ─────────────────────────────────

    function test_ValidateChannelClose_SpendLimit() public {
        vm.warp(1 days);

        vm.prank(payer);
        policy.setPolicy(50 ether, 0, 0, false);

        uint256 openedAt = block.timestamp;
        bytes memory metadata = abi.encode(openedAt, bytes(""));

        // elapsedDays = 1, so 50 ether is allowed
        bool result = policy.validateChannelClose(payer, payee, 100 ether, 50 ether, metadata);
        assertTrue(result);

        // 51 ether > 50 ether => revert
        vm.expectRevert(
            abi.encodeWithSelector(SpendingPolicy.SpendTooHigh.selector, 51 ether, 50 ether)
        );
        policy.validateChannelClose(payer, payee, 100 ether, 51 ether, metadata);
    }

    function test_ValidateChannelClose_ProportionalSpendLimit() public {
        // Ensure block.timestamp is high enough for subtraction
        vm.warp(30 days);

        // maxSpendPerDay = 10 ether, channel opened 5 days ago → max = 6 days * 10 = 60 ether
        vm.prank(payer);
        policy.setPolicy(10 ether, 0, 0, false);

        uint256 openedAt = block.timestamp - 5 days;
        bytes memory metadata = abi.encode(openedAt, bytes(""));

        // 60 ether within 6-day window
        bool result = policy.validateChannelClose(payer, payee, 100 ether, 60 ether, metadata);
        assertTrue(result);

        // 61 ether exceeds limit
        vm.expectRevert(
            abi.encodeWithSelector(SpendingPolicy.SpendTooHigh.selector, 61 ether, 60 ether)
        );
        policy.validateChannelClose(payer, payee, 100 ether, 61 ether, metadata);
    }

    function test_ValidateChannelClose_ZeroMaxSpendSkips() public {
        vm.prank(payer);
        policy.setPolicy(0, 0, 0, false);

        bool result = policy.validateChannelClose(
            payer, payee, 100 ether, 10000 ether, abi.encode(uint256(0), "")
        );
        assertTrue(result);
    }

    // ─── Allowed Providers ─────────────────────────────────────────────────

    function test_AddAllowedProvider() public {
        vm.prank(payer);
        policy.addAllowedProvider(payee);

        assertEq(policy.getAllowedProviderCount(payer), 1);
    }

    function test_AddAllowedProvider_EmitsEvent() public {
        vm.prank(payer);
        vm.expectEmit(true, true, false, false);
        emit AllowedProviderAdded(payer, payee);
        policy.addAllowedProvider(payee);
    }

    function test_Revert_AddAllowedProvider_Duplicate() public {
        vm.startPrank(payer);
        policy.addAllowedProvider(payee);

        vm.expectRevert(
            abi.encodeWithSelector(SpendingPolicy.ProviderAlreadyAllowed.selector, payee)
        );
        policy.addAllowedProvider(payee);
        vm.stopPrank();
    }

    function test_RemoveAllowedProvider() public {
        vm.startPrank(payer);
        policy.addAllowedProvider(payee);
        assertEq(policy.getAllowedProviderCount(payer), 1);

        policy.removeAllowedProvider(payee);
        assertEq(policy.getAllowedProviderCount(payer), 0);
        vm.stopPrank();
    }

    function test_RemoveAllowedProvider_EmitsEvent() public {
        vm.startPrank(payer);
        policy.addAllowedProvider(payee);

        vm.expectEmit(true, true, false, false);
        emit AllowedProviderRemoved(payer, payee);
        policy.removeAllowedProvider(payee);
        vm.stopPrank();
    }

    function test_Revert_RemoveAllowedProvider_NotInList() public {
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(SpendingPolicy.ProviderNotAllowed.selector, payee)
        );
        policy.removeAllowedProvider(payee);
    }

    function test_ValidateChannelClose_ProviderFilter() public {
        vm.startPrank(payer);
        policy.setPolicy(0, 0, 0, false);
        policy.addAllowedProvider(payee);
        vm.stopPrank();

        // payee is allowed
        bool result = policy.validateChannelClose(
            payer, payee, 100 ether, 10 ether, abi.encode(uint256(0), "")
        );
        assertTrue(result);

        // other is not allowed
        vm.expectRevert(
            abi.encodeWithSelector(SpendingPolicy.ProviderNotAllowed.selector, other)
        );
        policy.validateChannelClose(
            payer, other, 100 ether, 10 ether, abi.encode(uint256(0), "")
        );
    }

    function test_ValidateChannelClose_EmptyProviderListAllowsAll() public {
        vm.prank(payer);
        policy.setPolicy(0, 0, 0, false);

        // No provider filter — any payee is allowed
        bool result = policy.validateChannelClose(
            payer, payee, 100 ether, 10 ether, abi.encode(uint256(0), "")
        );
        assertTrue(result);
    }

    // ─── Allowed Services ──────────────────────────────────────────────────

    function test_AddAllowedService() public {
        bytes32 sid = keccak256(abi.encodePacked("test-service"));

        vm.prank(payer);
        policy.addAllowedService(sid);

        assertEq(policy.getAllowedServiceCount(payer), 1);
    }

    function test_AddAllowedService_EmitsEvent() public {
        bytes32 sid = keccak256(abi.encodePacked("test-service"));

        vm.prank(payer);
        vm.expectEmit(true, true, false, false);
        emit AllowedServiceAdded(payer, sid);
        policy.addAllowedService(sid);
    }

    function test_Revert_AddAllowedService_Duplicate() public {
        bytes32 sid = keccak256(abi.encodePacked("test-service"));

        vm.startPrank(payer);
        policy.addAllowedService(sid);

        vm.expectRevert(
            abi.encodeWithSelector(SpendingPolicy.ServiceAlreadyAllowed.selector, sid)
        );
        policy.addAllowedService(sid);
        vm.stopPrank();
    }

    function test_RemoveAllowedService() public {
        bytes32 sid = keccak256(abi.encodePacked("test-service"));

        vm.startPrank(payer);
        policy.addAllowedService(sid);
        assertEq(policy.getAllowedServiceCount(payer), 1);

        policy.removeAllowedService(sid);
        assertEq(policy.getAllowedServiceCount(payer), 0);
        vm.stopPrank();
    }

    function test_RemoveAllowedService_EmitsEvent() public {
        bytes32 sid = keccak256(abi.encodePacked("test-service"));

        vm.startPrank(payer);
        policy.addAllowedService(sid);

        vm.expectEmit(true, true, false, false);
        emit AllowedServiceRemoved(payer, sid);
        policy.removeAllowedService(sid);
        vm.stopPrank();
    }

    function test_Revert_RemoveAllowedService_NotInList() public {
        bytes32 sid = keccak256(abi.encodePacked("test-service"));

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(SpendingPolicy.ServiceNotAllowed.selector, sid)
        );
        policy.removeAllowedService(sid);
    }

    function test_RemoveAllowedService_WithMultipleEntries() public {
        bytes32 sid1 = keccak256(abi.encodePacked("svc-1"));
        bytes32 sid2 = keccak256(abi.encodePacked("svc-2"));
        bytes32 sid3 = keccak256(abi.encodePacked("svc-3"));

        vm.startPrank(payer);
        policy.addAllowedService(sid1);
        policy.addAllowedService(sid2);
        policy.addAllowedService(sid3);

        assertEq(policy.getAllowedServiceCount(payer), 3);

        // Remove middle element
        policy.removeAllowedService(sid2);

        assertEq(policy.getAllowedServiceCount(payer), 2);

        // Verify can re-add without duplicate error
        policy.addAllowedService(sid2);
        assertEq(policy.getAllowedServiceCount(payer), 3);
        vm.stopPrank();
    }

    // ─── requireRegisteredService ──────────────────────────────────────────

    function test_RequireRegisteredService_NotRegistered() public {
        vm.prank(payer);
        policy.setPolicy(0, 0, 0, true);

        // payee is not registered in ServiceRegistry
        vm.expectRevert(
            abi.encodeWithSelector(SpendingPolicy.PayeeNotRegistered.selector, payee)
        );
        policy.validateChannelOpen(
            payer, payee, 1 ether, uint32(block.timestamp + 1 days), abi.encode(uint256(0), "")
        );
    }

    function test_RequireRegisteredService_Registered() public {
        // Register the payee in ServiceRegistry
        vm.prank(payee);
        registry.register("ipfs://payee-service", 1 ether, 5000);

        vm.prank(payer);
        policy.setPolicy(0, 0, 0, true);

        bool result = policy.validateChannelOpen(
            payer, payee, 1 ether, uint32(block.timestamp + 1 days), abi.encode(uint256(0), "")
        );
        assertTrue(result);
    }

    function test_RequireRegisteredService_RegisteredButInactive() public {
        // Register and then deactivate
        vm.startPrank(payee);
        bytes32 sid = registry.register("ipfs://payee-service", 1 ether, 5000);
        registry.deactivateService(sid);
        vm.stopPrank();

        vm.prank(payer);
        policy.setPolicy(0, 0, 0, true);

        vm.expectRevert(
            abi.encodeWithSelector(SpendingPolicy.PayeeNotRegistered.selector, payee)
        );
        policy.validateChannelOpen(
            payer, payee, 1 ether, uint32(block.timestamp + 1 days), abi.encode(uint256(0), "")
        );
    }

    // ─── Combined Policy Checks ────────────────────────────────────────────

    function test_CombinedPolicy_AllChecksPass() public {
        vm.warp(1 days);

        // Register the payee in ServiceRegistry
        vm.prank(payee);
        registry.register("ipfs://payee-service", 1 ether, 5000);

        // Set up restrictive policy
        vm.startPrank(payer);
        policy.setPolicy(100 ether, 20 ether, 10 days, true);
        policy.addAllowedProvider(payee);
        vm.stopPrank();

        // Open validation: within limits
        bool openResult = policy.validateChannelOpen(
            payer, payee, 15 ether, uint32(block.timestamp + 7 days), abi.encode(uint256(0), "")
        );
        assertTrue(openResult);

        // Close validation: within spend limit, provider allowed
        bool closeResult = policy.validateChannelClose(
            payer, payee, 15 ether, 50 ether, abi.encode(block.timestamp, bytes(""))
        );
        assertTrue(closeResult);
    }

    function test_CombinedPolicy_OpenFailsOnDeposit() public {
        vm.prank(payer);
        policy.setPolicy(0, 10 ether, 0, false);

        vm.expectRevert(
            abi.encodeWithSelector(SpendingPolicy.DepositTooHigh.selector, 15 ether, 10 ether)
        );
        policy.validateChannelOpen(
            payer, payee, 15 ether, uint32(block.timestamp + 1 days), abi.encode(uint256(0), "")
        );
    }

    function test_CombinedPolicy_CloseFailsOnSpend() public {
        vm.warp(1 days * 100); // ensure block.timestamp is high enough for subtraction

        vm.prank(payer);
        policy.setPolicy(10 ether, 0, 0, false);

        uint256 openedAt = block.timestamp - 2 hours;

        // elapsedDays = ((2h) / 1d) + 1 = 0 + 1 = 1; allowance = 10 ether
        // 15 ether > 10 ether => revert
        vm.expectRevert(
            abi.encodeWithSelector(SpendingPolicy.SpendTooHigh.selector, 15 ether, 10 ether)
        );
        policy.validateChannelClose(
            payer, payee, 100 ether, 15 ether, abi.encode(openedAt, bytes(""))
        );
    }


    function test_CombinedPolicy_CloseFailsOnSpend_ShortDuration() public {
        vm.warp(1 days * 100);

        vm.prank(payer);
        policy.setPolicy(10 ether, 0, 0, false);

        uint256 openedAt = block.timestamp - 2 hours; // < 1 day, so elapsedDays = 1

        vm.expectRevert(
            abi.encodeWithSelector(SpendingPolicy.SpendTooHigh.selector, 15 ether, 10 ether)
        );
        policy.validateChannelClose(
            payer, payee, 100 ether, 15 ether, abi.encode(openedAt, bytes(""))
        );
    }

    // ─── ServiceRegistry Integration ───────────────────────────────────────

    function test_ServiceRegistryReturnsCorrectContract() public {
        assertEq(address(policy.serviceRegistry()), address(registry));
    }
}
