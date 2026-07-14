// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../OpenModelSettlement.sol";

/// @dev Test-only helper that attempts to re-enter OpenModelSettlement's
/// `nonReentrant` functions from within its `receive()` callback (triggered when
/// the contract receives native FIL during a withdrawal/claim). Used to prove the
/// ReentrancyGuard + checks-effects-interactions ordering block a double-spend.
contract ReentrantAttacker {
    OpenModelSettlement public immutable target;

    // 1 = withdrawEarnings, 2 = claimRefund, 3 = withdrawPlatformEarnings
    uint8 public mode;
    uint256 public refundId;

    bool public armed;            // only re-enter while armed
    bool public reentryReverted;  // set true if the re-entrant call reverted (good)
    uint256 public reentrySuccesses; // incremented if a re-entrant call somehow succeeded (bad)
    bytes public lastError;       // revert payload from the blocked re-entry

    constructor(address _target) {
        target = OpenModelSettlement(payable(_target));
    }

    function setMode(uint8 _mode, uint256 _refundId) external {
        mode = _mode;
        refundId = _refundId;
    }

    // --- setup helpers (forward calls so msg.sender == this attacker) ---
    function depositFIL() external payable {
        target.depositFIL{value: msg.value}();
    }

    // Two-step ownership: claim a nomination so tests can make this contract the owner.
    function acceptOwner() external {
        target.acceptOwnership();
    }

    function doRequestRefund(address token, uint256 amount) external returns (uint256) {
        return target.requestRefund(token, amount);
    }

    // --- attack triggers ---
    function triggerWithdraw(address token) external {
        armed = true;
        target.withdrawEarnings(token);
        armed = false;
    }

    function triggerClaim(uint256 id) external {
        armed = true;
        target.claimRefund(id);
        armed = false;
    }

    function triggerPlatformWithdraw(address token) external {
        armed = true;
        target.withdrawPlatformEarnings(token, address(this));
        armed = false;
    }

    receive() external payable {
        if (!armed) return;
        armed = false; // single re-entry attempt; the guard should reject it
        if (mode == 1) {
            try target.withdrawEarnings(address(0)) {
                reentrySuccesses++;
            } catch (bytes memory err) {
                reentryReverted = true;
                lastError = err;
            }
        } else if (mode == 2) {
            try target.claimRefund(refundId) {
                reentrySuccesses++;
            } catch (bytes memory err) {
                reentryReverted = true;
                lastError = err;
            }
        } else if (mode == 3) {
            try target.withdrawPlatformEarnings(address(0), address(this)) {
                reentrySuccesses++;
            } catch (bytes memory err) {
                reentryReverted = true;
                lastError = err;
            }
        }
    }
}
