// Shared helpers for the settlement test suite.
//
// WHY THIS EXISTS. v1.4 replaced the single token column of submitSettlement with a
// per-item volume vector, because a network that serves tokens and images cannot
// describe its volume with one number. Most of the suite predates that and is about
// behaviour that did NOT change — deposits, refunds, fees, freezing, pause. Those tests
// used the token column as a filler ("0 stats"), so re-writing every call site by hand
// would add churn without adding coverage.
//
// So the token-shaped call is expressed once, here, and the tests read as they did. Tests
// that actually exercise the unit semantics (BatchStats.test.js) call submitSettlement
// directly with an explicit volume vector.
//
// The values mirror the contract's UNIT_* constants. They are duplicated rather than read
// from the chain so a mismatch is a test failure (the contract's column count would not
// line up) instead of a silent agreement with whatever the contract happens to say.
const UNIT_TOKEN = 0;
const UNIT_IMAGE = 1;
const UNIT_AUDIO_SECOND = 2;
const UNIT_CHARACTER = 3;
const UNIT_COUNT = 4;

// tokenVolume builds the per-item volume vector for one item billed in tokens.
function tokenVolume(tokenCount) {
  const v = new Array(UNIT_COUNT).fill(0);
  v[UNIT_TOKEN] = tokenCount;
  return v;
}

// submitTokenSettlement is submitSettlement with the pre-v1.4 argument order: the
// trailing array is a TOKEN quantity, so every item's volume vector counts tokens only.
async function submitTokenSettlement(settlement, users, sps, amounts, tokens,
                                     requestCounts, tokenCounts, detailsHash) {
  const itemVolume = tokenCounts.map(tokenVolume);
  return settlement.submitSettlement(users, sps, amounts, tokens, requestCounts,
                                     itemVolume, detailsHash);
}

module.exports = {
  submitTokenSettlement, tokenVolume,
  UNIT_TOKEN, UNIT_IMAGE, UNIT_AUDIO_SECOND, UNIT_CHARACTER, UNIT_COUNT,
};
