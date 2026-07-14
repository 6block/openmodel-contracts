// Generate a fresh EVM wallet and produce a signed /v1/register payload.
// Message format MUST match the gateway's registrationMessage() byte-for-byte.
// Usage: node scripts/sign-register.js > /tmp/reg-payload.json
const { ethers } = require("ethers");
(async () => {
  const w = ethers.Wallet.createRandom();
  const issued = Math.floor(Date.now() / 1000);
  // wallet.address is EIP-55 checksummed, matching the server's common.HexToAddress().Hex().
  const message = `OpenModel API key registration\nwallet: ${w.address}\nissued_at: ${issued}`;
  const signature = await w.signMessage(message); // EIP-191 personal_sign
  process.stdout.write(JSON.stringify({ wallet: w.address, issued_at: issued, signature }) + "\n");
  process.stderr.write(`(generated wallet ${w.address}, private key kept only in memory)\n`);
})();
