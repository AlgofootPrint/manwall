// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract GuardianAttestationRegistry {
    struct Attestation {
        bytes32 evidenceHash;
        address subject;
        uint64 timestamp;
        uint8 severity;
        bool remediated;
        string evidenceURI;
    }

    address public immutable guardian;
    string public agentURI;
    uint256 public validationCount;
    mapping(bytes32 => Attestation) public attestations;

    event AgentRegistered(address indexed guardian, string agentURI);
    event ValidationPublished(
        bytes32 indexed scanId,
        address indexed subject,
        bytes32 evidenceHash,
        uint8 severity,
        bool remediated,
        string evidenceURI
    );

    constructor(string memory identityURI) {
        guardian = msg.sender;
        agentURI = identityURI;
        emit AgentRegistered(msg.sender, identityURI);
    }

    function publishValidation(
        bytes32 scanId,
        address subject,
        bytes32 evidenceHash,
        uint8 severity,
        bool remediated,
        string calldata evidenceURI
    ) external {
        require(msg.sender == guardian, "guardian only");
        require(attestations[scanId].timestamp == 0, "already published");

        attestations[scanId] = Attestation(
            evidenceHash,
            subject,
            uint64(block.timestamp),
            severity,
            remediated,
            evidenceURI
        );
        validationCount++;
        emit ValidationPublished(scanId, subject, evidenceHash, severity, remediated, evidenceURI);
    }
}
