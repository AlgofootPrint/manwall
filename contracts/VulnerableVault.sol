// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract VulnerableVault {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "no balance");

        // Vulnerability: external interaction occurs before state is updated.
        (bool sent,) = msg.sender.call{value: amount}("");
        require(sent, "transfer failed");
        balances[msg.sender] = 0;
    }
}
