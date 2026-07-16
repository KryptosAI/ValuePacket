// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IEAS {
    function attest(AttestationRequest calldata request) external payable returns (bytes32);
    function getAttestation(bytes32 uid) external view returns (Attestation memory);

    struct AttestationRequest {
        bytes32 schema;
        AttestationRequestData data;
    }

    struct AttestationRequestData {
        address recipient;
        uint64 expirationTime;
        bool revocable;
        bytes32 refUID;
        bytes data;
        uint256 value;
    }

    struct Attestation {
        bytes32 uid;
        bytes32 schema;
        uint64 time;
        uint64 expirationTime;
        uint64 revocationTime;
        bytes32 refUID;
        address recipient;
        address attester;
        bool revocable;
        bytes data;
    }
}

/// @title AgentReputation
/// @notice Wraps EAS attestations so payers can rate agent service quality
///         after every ValuePacket transaction.
contract AgentReputation {
    IEAS public immutable EAS;
    bytes32 public immutable SCHEMA_UID;

    struct Rating {
        bytes32 uid;
        address provider;
        address payer;
        bytes32 channelId;
        uint8 score;
        string comment;
        uint64 timestamp;
    }

    mapping(address => bytes32[]) private _providerRatings;
    mapping(bytes32 => uint8) private _scores;
    mapping(bytes32 => mapping(address => bool)) private _hasRated;

    error InvalidScore();
    error AlreadyRated();
    error InvalidPagination();

    event ServiceRated(
        address indexed provider,
        address indexed payer,
        bytes32 indexed channelId,
        uint8 score
    );

    /// @param eas Address of the EAS contract
    /// @dev Computes the schema UID and boots the schema with a self-attestation.
    ///      In production the schema must first be registered with the EAS
    ///      SchemaRegistry contract. The constructor attestation will revert
    ///      unless the schema is already registered.
    constructor(address eas) {
        EAS = IEAS(eas);

        SCHEMA_UID = keccak256(
            abi.encodePacked(
                "address provider,address payer,bytes32 channelId,uint8 score,string comment",
                address(0),
                true
            )
        );

        EAS.attest(
            IEAS.AttestationRequest({
                schema: SCHEMA_UID,
                data: IEAS.AttestationRequestData({
                    recipient: address(0),
                    expirationTime: 0,
                    revocable: true,
                    refUID: bytes32(0),
                    data: abi.encode(address(0), address(0), bytes32(0), uint8(0), ""),
                    value: 0
                })
            })
        );
    }

    /// @notice Rate a service provider after a ValuePacket transaction.
    /// @param provider  Address of the agent service provider being rated.
    /// @param channelId Unique identifier of the payment channel.
    /// @param score     Rating from 0 (worst) to 10 (best).
    /// @param comment   Optional human-readable feedback.
    /// @return uid The EAS attestation UID for this rating.
    function rateService(
        address provider,
        bytes32 channelId,
        uint8 score,
        string calldata comment
    ) external returns (bytes32 uid) {
        if (score > 10) revert InvalidScore();
        if (_hasRated[channelId][msg.sender]) revert AlreadyRated();

        _hasRated[channelId][msg.sender] = true;

        bytes memory attestationData = abi.encode(
            provider,
            msg.sender,
            channelId,
            score,
            comment
        );

        uid = EAS.attest(
            IEAS.AttestationRequest({
                schema: SCHEMA_UID,
                data: IEAS.AttestationRequestData({
                    recipient: provider,
                    expirationTime: 0,
                    revocable: true,
                    refUID: bytes32(0),
                    data: attestationData,
                    value: 0
                })
            })
        );

        _providerRatings[provider].push(uid);
        _scores[uid] = score;

        emit ServiceRated(provider, msg.sender, channelId, score);
    }

    /// @notice Paginate through a provider's ratings (most recent last).
    /// @param provider Provider to fetch ratings for.
    /// @param offset   Number of ratings to skip.
    /// @param limit    Maximum ratings to return.
    /// @return results Array of Rating structs.
    function getRatings(
        address provider,
        uint256 offset,
        uint256 limit
    ) external view returns (Rating[] memory results) {
        if (limit == 0) revert InvalidPagination();

        bytes32[] storage uids = _providerRatings[provider];
        uint256 total = uids.length;
        if (offset >= total) return new Rating[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 resultLen = end - offset;

        results = new Rating[](resultLen);
        for (uint256 i = 0; i < resultLen; i++) {
            bytes32 u = uids[offset + i];
            IEAS.Attestation memory att = EAS.getAttestation(u);
            (
                address decodedProvider,
                address decodedPayer,
                bytes32 decodedChannelId,
                uint8 decodedScore,
                string memory decodedComment
            ) = abi.decode(att.data, (address, address, bytes32, uint8, string));

            results[i] = Rating({
                uid: u,
                provider: decodedProvider,
                payer: decodedPayer,
                channelId: decodedChannelId,
                score: decodedScore,
                comment: decodedComment,
                timestamp: att.time
            });
        }
    }

    /// @notice Returns the arithmetic mean of all scores for a provider.
    /// @param provider Provider address.
    /// @return average Average score (0 if no ratings exist). Truncated to integer.
    function getAverageScore(address provider) external view returns (uint256) {
        bytes32[] storage uids = _providerRatings[provider];
        uint256 count = uids.length;
        if (count == 0) return 0;

        uint256 sum;
        for (uint256 i = 0; i < count; i++) {
            sum += _scores[uids[i]];
        }

        return sum / count;
    }

    /// @notice Number of ratings a provider has received.
    /// @param provider Provider address.
    /// @return count Total rating count.
    function getRatingCount(address provider) external view returns (uint256) {
        return _providerRatings[provider].length;
    }

    /// @notice Look up the score for a specific attestation UID.
    /// @param uid EAS attestation UID.
    /// @return score The stored score (0-10).
    function getScore(bytes32 uid) external view returns (uint8) {
        return _scores[uid];
    }

    /// @notice Check whether a payer has already rated a given channel.
    /// @param channelId Payment channel identifier.
    /// @param payer     Payer address.
    /// @return rated True if the payer has already submitted a rating for this channel.
    function hasRated(bytes32 channelId, address payer) external view returns (bool) {
        return _hasRated[channelId][payer];
    }
}
