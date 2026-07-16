// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {AgentReputation, IEAS} from "../src/extensions/AgentReputation.sol";

contract AgentReputationTest is Test {
    MockEAS public eas;
    AgentReputation public reputation;

    address public providerA = address(0xA);
    address public providerB = address(0xB);
    address public payer1   = address(0x1);
    address public payer2   = address(0x2);
    address public payer3   = address(0x3);

    bytes32 public constant CHANNEL_1 = bytes32(uint256(1));
    bytes32 public constant CHANNEL_2 = bytes32(uint256(2));
    bytes32 public constant CHANNEL_3 = bytes32(uint256(3));

    event ServiceRated(
        address indexed provider,
        address indexed payer,
        bytes32 indexed channelId,
        uint8 score
    );

    function setUp() public {
        eas = new MockEAS();
        reputation = new AgentReputation(address(eas));
    }

    // ─── Helpers ─────────────────────────────────────────────────────────

    function _rate(
        address provider,
        bytes32 channelId,
        uint8 score,
        string memory comment
    ) internal returns (bytes32) {
        vm.prank(payer1);
        return reputation.rateService(provider, channelId, score, comment);
    }

    function _rateAs(
        address caller,
        address provider,
        bytes32 channelId,
        uint8 score,
        string memory comment
    ) internal returns (bytes32) {
        vm.prank(caller);
        return reputation.rateService(provider, channelId, score, comment);
    }

    // ─── Schema UID ──────────────────────────────────────────────────────

    function test_SchemaUID_IsSet() public {
        bytes32 expected = keccak256(
            abi.encodePacked(
                "address provider,address payer,bytes32 channelId,uint8 score,string comment",
                address(0),
                true
            )
        );
        assertEq(reputation.SCHEMA_UID(), expected);
    }

    function test_EAS_IsSet() public {
        assertEq(address(reputation.EAS()), address(eas));
    }

    // ─── Rate Service ────────────────────────────────────────────────────

    function test_RateService_StoresAttestation() public {
        bytes32 uid = _rate(providerA, CHANNEL_1, 8, "great service");

        assertTrue(uid != bytes32(0));
        assertEq(reputation.getScore(uid), 8);
        assertTrue(reputation.hasRated(CHANNEL_1, payer1));

        IEAS.Attestation memory att = eas.getAttestation(uid);
        assertEq(att.schema, reputation.SCHEMA_UID());
        assertEq(att.recipient, providerA);
        assertEq(att.attester, address(reputation));
        assertTrue(att.revocable);

        (
            address decodedProvider,
            address decodedPayer,
            bytes32 decodedChannelId,
            uint8 decodedScore,
            string memory decodedComment
        ) = abi.decode(att.data, (address, address, bytes32, uint8, string));

        assertEq(decodedProvider, providerA);
        assertEq(decodedPayer, payer1);
        assertEq(decodedChannelId, CHANNEL_1);
        assertEq(decodedScore, 8);
        assertEq(decodedComment, "great service");
    }

    function test_RateService_EmitsEvent() public {
        vm.prank(payer1);
        vm.expectEmit(true, true, true, true);
        emit ServiceRated(providerA, payer1, CHANNEL_1, 7);
        reputation.rateService(providerA, CHANNEL_1, 7, "solid");
    }

    // ─── Average Score ───────────────────────────────────────────────────

    function test_GetAverageScore_SingleRating() public {
        _rate(providerA, CHANNEL_1, 8, "good");
        assertEq(reputation.getAverageScore(providerA), 8);
    }

    function test_GetAverageScore_MultipleRatings() public {
        _rate(providerA, CHANNEL_1, 8, "good");
        _rate(providerA, CHANNEL_2, 6, "decent");
        _rate(providerA, CHANNEL_3, 10, "perfect");

        assertEq(reputation.getAverageScore(providerA), 8); // (8+6+10)/3 = 8
    }

    function test_GetAverageScore_NoRatings() public {
        assertEq(reputation.getAverageScore(providerA), 0);
    }

    function test_GetAverageScore_TruncatesDown() public {
        _rate(providerA, CHANNEL_1, 7, "");
        _rate(providerA, CHANNEL_2, 8, "");

        assertEq(reputation.getAverageScore(providerA), 7); // (7+8)/2 = 7
    }

    // ─── Rating Count ────────────────────────────────────────────────────

    function test_GetRatingCount() public {
        assertEq(reputation.getRatingCount(providerA), 0);

        _rate(providerA, CHANNEL_1, 5, "");
        assertEq(reputation.getRatingCount(providerA), 1);

        _rate(providerA, CHANNEL_2, 6, "");
        assertEq(reputation.getRatingCount(providerA), 2);
    }

    function test_GetRatingCount_Independent() public {
        _rate(providerA, CHANNEL_1, 5, "");
        _rate(providerA, CHANNEL_2, 6, "");
        _rateAs(payer2, providerB, CHANNEL_1, 7, "");

        assertEq(reputation.getRatingCount(providerA), 2);
        assertEq(reputation.getRatingCount(providerB), 1);
    }

    // ─── Reverts ─────────────────────────────────────────────────────────

    function test_Revert_InvalidScore_Above10() public {
        vm.prank(payer1);
        vm.expectRevert(AgentReputation.InvalidScore.selector);
        reputation.rateService(providerA, CHANNEL_1, 11, "too high");
    }

    function test_Revert_InvalidScore_Above10_Boundary() public {
        _rate(providerA, CHANNEL_1, 10, "perfect");

        vm.prank(payer1);
        vm.expectRevert(AgentReputation.InvalidScore.selector);
        reputation.rateService(providerA, CHANNEL_2, 11, "");
    }

    function test_Revert_AlreadyRated() public {
        _rate(providerA, CHANNEL_1, 5, "first");

        vm.prank(payer1);
        vm.expectRevert(AgentReputation.AlreadyRated.selector);
        reputation.rateService(providerA, CHANNEL_1, 8, "second");
    }

    // ─── Anyone Can Rate ─────────────────────────────────────────────────

    function test_RateService_NonPayerCanRate() public {
        bytes32 uid = _rateAs(payer2, providerA, CHANNEL_1, 9, "nice");
        assertEq(reputation.getScore(uid), 9);
        assertEq(reputation.getRatingCount(providerA), 1);
    }

    function test_RateService_DifferentPayers_DifferentChannels() public {
        bytes32 uid1 = _rateAs(payer1, providerA, CHANNEL_1, 7, "");
        bytes32 uid2 = _rateAs(payer2, providerA, CHANNEL_2, 9, "");
        bytes32 uid3 = _rateAs(payer3, providerA, CHANNEL_3, 5, "");

        assertEq(reputation.getScore(uid1), 7);
        assertEq(reputation.getScore(uid2), 9);
        assertEq(reputation.getScore(uid3), 5);

        assertEq(reputation.getRatingCount(providerA), 3);
        assertEq(reputation.getAverageScore(providerA), 7); // (7+9+5)/3 = 7
    }

    function test_RateService_SameChannel_DifferentPayers() public {
        _rateAs(payer1, providerA, CHANNEL_1, 4, "");
        _rateAs(payer2, providerA, CHANNEL_1, 8, "");

        assertEq(reputation.getRatingCount(providerA), 2);
        assertTrue(reputation.hasRated(CHANNEL_1, payer1));
        assertTrue(reputation.hasRated(CHANNEL_1, payer2));
    }

    // ─── Get Ratings (Pagination) ────────────────────────────────────────

    function test_GetRatings_Paginated() public {
        _rateAs(payer1, providerA, CHANNEL_1, 5, "ok");
        _rateAs(payer1, providerA, CHANNEL_2, 7, "better");
        _rateAs(payer1, providerA, CHANNEL_3, 9, "great");

        AgentReputation.Rating[] memory page1 = reputation.getRatings(providerA, 0, 2);
        assertEq(page1.length, 2);
        assertEq(page1[0].score, 5);
        assertEq(page1[0].comment, "ok");
        assertEq(page1[1].score, 7);
        assertEq(page1[1].comment, "better");

        AgentReputation.Rating[] memory page2 = reputation.getRatings(providerA, 2, 2);
        assertEq(page2.length, 1);
        assertEq(page2[0].score, 9);
        assertEq(page2[0].comment, "great");

        AgentReputation.Rating[] memory page3 = reputation.getRatings(providerA, 3, 2);
        assertEq(page3.length, 0);
    }

    function test_GetRatings_EmptyProvider() public {
        AgentReputation.Rating[] memory results = reputation.getRatings(providerA, 0, 10);
        assertEq(results.length, 0);
    }

    function test_Revert_GetRatings_ZeroLimit() public {
        _rate(providerA, CHANNEL_1, 5, "");
        vm.expectRevert(AgentReputation.InvalidPagination.selector);
        reputation.getRatings(providerA, 0, 0);
    }

    // ─── Multiple Providers ──────────────────────────────────────────────

    function test_MultipleProviders_Isolated() public {
        _rateAs(payer1, providerA, CHANNEL_1, 10, "excellent");
        _rateAs(payer1, providerA, CHANNEL_2, 8, "good");
        _rateAs(payer2, providerB, bytes32(uint256(10)), 2, "bad");

        assertEq(reputation.getRatingCount(providerA), 2);
        assertEq(reputation.getAverageScore(providerA), 9); // (10+8)/2 = 9
        assertEq(reputation.getRatingCount(providerB), 1);
        assertEq(reputation.getAverageScore(providerB), 2);
    }

    // ─── Score 0 Is Valid ────────────────────────────────────────────────

    function test_RateService_ScoreZero() public {
        bytes32 uid = _rate(providerA, CHANNEL_1, 0, "worst");
        assertEq(reputation.getScore(uid), 0);
        assertEq(reputation.getAverageScore(providerA), 0);
    }
}

/// @notice Minimal EAS mock for testing. Generates deterministic UIDs and
///         stores attestation structs without schema-registry checks.
contract MockEAS {
    mapping(bytes32 => IEAS.Attestation) private _attestations;

    event Attested(bytes32 indexed uid, address indexed attester, address indexed recipient);

    function attest(
        IEAS.AttestationRequest calldata request
    ) external returns (bytes32 uid) {
        uid = keccak256(
            abi.encodePacked(
                request.schema,
                request.data.recipient,
                msg.sender,
                request.data.data,
                block.timestamp,
                block.prevrandao
            )
        );

        _attestations[uid] = IEAS.Attestation({
            uid: uid,
            schema: request.schema,
            time: uint64(block.timestamp),
            expirationTime: request.data.expirationTime,
            revocationTime: 0,
            refUID: request.data.refUID,
            recipient: request.data.recipient,
            attester: msg.sender,
            revocable: request.data.revocable,
            data: request.data.data
        });

        emit Attested(uid, msg.sender, request.data.recipient);
    }

    function getAttestation(bytes32 uid) external view returns (IEAS.Attestation memory) {
        return _attestations[uid];
    }

    function attestationExists(bytes32 uid) external view returns (bool) {
        return _attestations[uid].uid != bytes32(0);
    }
}
