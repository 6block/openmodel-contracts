require("@nomicfoundation/hardhat-toolbox");

// Signer key, by role. Deploy/admin scripts want the cold owner key
// (DEPLOYER_PRIVATE_KEY); a user depositing into the contract has no business
// exporting that, so DEPOSITOR_PRIVATE_KEY is accepted too — mainnet-deposit.js
// documents the latter, and used to fail with a misleading "export
// DEPOSITOR_PRIVATE_KEY first" no matter how many times you exported it.
function signerKey() {
  for (const name of ["DEPLOYER_PRIVATE_KEY", "DEPOSITOR_PRIVATE_KEY"]) {
    if (process.env[name]) return [process.env[name]];
  }
  return [];
}

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    calibration: {
      url: process.env.FEVM_RPC_URL || "https://api.calibration.node.glif.io/rpc/v1",
      chainId: 314159,
      accounts: signerKey(),
    },
    mainnet: {
      // glif intermittently answers eth_call with an empty body, which decodes as a
      // plausible zero balance — ankr has been the reliable primary.
      url: process.env.MAINNET_RPC_URL || "https://rpc.ankr.com/filecoin",
      chainId: 314,
      accounts: signerKey(),
    },
  },
  // Source verification on the Filecoin Blockscout explorers, so the contract
  // pages expose a human-readable "Read contract" tab (cumulative counters,
  // getSettlement) and decode SettlementExecuted logs. Blockscout ignores the API
  // key value but the plugin requires one to be present.
  etherscan: {
    apiKey: {
      calibration: "blockscout",
      mainnet: "blockscout",
    },
    customChains: [
      {
        network: "calibration",
        chainId: 314159,
        urls: {
          apiURL: "https://filecoin-testnet.blockscout.com/api",
          browserURL: "https://filecoin-testnet.blockscout.com",
        },
      },
      {
        network: "mainnet",
        chainId: 314,
        urls: {
          apiURL: "https://filecoin.blockscout.com/api",
          browserURL: "https://filecoin.blockscout.com",
        },
      },
    ],
  },
  sourcify: {
    enabled: false,
  },
};
