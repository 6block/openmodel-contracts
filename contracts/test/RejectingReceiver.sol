// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../OpenModelSettlement.sol";

/// @dev Test-only helper that CANNOT receive native FIL: it has no payable
/// receive()/fallback, so any `to.call{value:...}` into it fails. Used to prove
/// _transferOut's `require(success, "FIL transfer failed")` branch reverts and
/// rolls back state (earnings/refund stay intact, not lost).
contract RejectingReceiver {
    OpenModelSettlement public immutable target;

    constructor(address _target) {
        target = OpenModelSettlement(payable(_target));
    }

    // payable so the test can fund a deposit THROUGH this contract (forwards out;
    // this never *receives* FIL, it only sends).
    function depositFIL() external payable {
        target.depositFIL{value: msg.value}();
    }

    function doRequestRefund(address token, uint256 amount) external returns (uint256) {
        return target.requestRefund(token, amount);
    }

    function withdraw(address token) external {
        target.withdrawEarnings(token);
    }

    function claim(uint256 id) external {
        target.claimRefund(id);
    }

    // NOTE: deliberately NO receive() and NO fallback → incoming native FIL reverts.
}
