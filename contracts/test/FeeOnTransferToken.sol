// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only ERC20 that burns a 10% fee on every transfer, so the recipient
/// receives less than the requested amount. Used to verify depositToken credits the
/// ACTUAL received amount (balance diff), not the requested amount.
contract FeeOnTransferToken is ERC20 {
    uint256 public constant FEE_BPS = 1000; // 10%

    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = (value * FEE_BPS) / 10000;
            super._update(from, to, value - fee);
            super._update(from, address(0), fee); // burn the fee
        } else {
            super._update(from, to, value);
        }
    }
}
