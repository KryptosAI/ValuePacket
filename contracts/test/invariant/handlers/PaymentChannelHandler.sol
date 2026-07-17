// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymentChannel} from "../../../src/PaymentChannel.sol";
import {MockUSDC} from "../../../src/mocks/MockUSDC.sol";

contract PaymentChannelHandler is Test {
    PaymentChannel public immutable channels;
    MockUSDC public immutable usdc;

    uint256 internal constant PAYER_KEY = 0xA11CE;
    address public immutable channelPayer;
    address public immutable channelPayee;

    uint256[] public channelIds;
    mapping(uint256 => bool) public isFinalized;
    mapping(uint256 => PaymentChannel.Status) public recordedFinalStatus;

    constructor(PaymentChannel _channels, MockUSDC _usdc) {
        channels = _channels;
        usdc = _usdc;
        channelPayer = vm.addr(PAYER_KEY);
        channelPayee = makeAddr("channelPayee");

        usdc.mint(channelPayer, type(uint128).max);
        vm.prank(channelPayer);
        usdc.approve(address(channels), type(uint256).max);
    }

    function channelCount() external view returns (uint256) {
        return channelIds.length;
    }

    function openChannel(uint256 depositSeed, uint256 durationSeed) external {
        uint256 deposit = bound(depositSeed, 1, 1_000_000e6);
        uint32 duration = uint32(bound(durationSeed, 1 hours, 30 days));

        vm.prank(channelPayer);
        uint256 id = channels.openChannel(
            channelPayee,
            address(usdc),
            deposit,
            uint32(block.timestamp) + duration,
            address(0),
            ""
        );
        channelIds.push(id);
    }

    function closeChannel(uint256 idSeed, uint256 spentSeed) external {
        uint256 id = _pickOpenChannel(idSeed);
        if (id == 0) return;

        PaymentChannel.Channel memory ch = channels.getChannel(id);
        uint256 spent = bound(spentSeed, 0, ch.deposit);

        bytes32 structHash =
            keccak256(abi.encode(channels.CHANNEL_CLOSE_TYPEHASH(), id, spent));
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_KEY, digest);

        vm.prank(channelPayee);
        channels.closeChannel(id, spent, abi.encodePacked(r, s, v));

        isFinalized[id] = true;
        recordedFinalStatus[id] = PaymentChannel.Status.Settled;
    }

    function refundChannel(uint256 idSeed) external {
        uint256 id = _pickOpenChannel(idSeed);
        if (id == 0) return;

        PaymentChannel.Channel memory ch = channels.getChannel(id);
        vm.warp(uint256(ch.expiresAt) + 1);

        vm.prank(channelPayer);
        channels.refundChannel(id);

        isFinalized[id] = true;
        recordedFinalStatus[id] = PaymentChannel.Status.Refunded;
    }

    function extendChannel(uint256 idSeed, uint256 extraTimeSeed, uint256 addSeed) external {
        uint256 id = _pickOpenChannel(idSeed);
        if (id == 0) return;

        PaymentChannel.Channel memory ch = channels.getChannel(id);
        uint32 newExpiry = uint32(uint256(ch.expiresAt) + bound(extraTimeSeed, 1, 30 days));
        uint256 additional = bound(addSeed, 0, 1_000_000e6);

        vm.prank(channelPayer);
        channels.extendChannel(id, newExpiry, additional);
    }

    function _pickOpenChannel(uint256 seed) internal view returns (uint256) {
        uint256 n = channelIds.length;
        if (n == 0) return 0;
        uint256 start = seed % n;
        for (uint256 i = 0; i < n; i++) {
            uint256 id = channelIds[(start + i) % n];
            if (channels.getChannel(id).status == PaymentChannel.Status.Open) {
                return id;
            }
        }
        return 0;
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("ValuePacket")),
                keccak256(bytes("1")),
                block.chainid,
                address(channels)
            )
        );
    }
}
