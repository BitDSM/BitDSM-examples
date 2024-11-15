// Description: This script demonstrates how an operator can register with the AVS and respond to tasks.
// It also demonstrates how to monitor for new tasks.
// run this using ts-node operator/index.ts

import { ethers } from "ethers";
import { getBytes as arrayify } from "ethers";
import * as dotenv from "dotenv";
//const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
dotenv.config();

// Check if the process.env object is empty
if (!Object.keys(process.env).length) {
  throw new Error("process.env object is empty");
}

// Setup env variables
// Use RPC_URL for connecting to anvil testnet
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const uri = process.env.Operator_URI;
let chainId = 31337;

// Load deployment data
const coreDeploymentData = JSON.parse(
  fs.readFileSync(
    path.resolve(
      __dirname,
      `../eigenlayer_addresses.json`
    ),
    "utf8"
  )
);
const avsDeploymentData = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, `../bitdsm_addresses.json`),
    "utf8"
  )
);

const delegationManagerAddress = coreDeploymentData.anvil.delegationManager;
const avsDirectoryAddress = coreDeploymentData.anvil.avsDirectory;

const bitDSMServiceManagerAddress = avsDeploymentData.BitDSMServiceManagerProxy;
const bitDSMRegistryAddress = avsDeploymentData.BitDSMRegistryProxy;
const bitcoinPodManagerAddress = avsDeploymentData.BitcoinPodManagerProxy;

// Load ABIs
const delegationManagerABI = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../abis/IDelegationManager.json"),
    "utf8"
  )
);
const bitDSMRegistryABI = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../abis/BitDSMRegistry.json"),
    "utf8"
  )
);
const bitDSMServiceManagerABI = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../abis/BitDSMServiceManager.json"),
    "utf8"
  )
);
const bitcoinPodManagerABI = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../abis/BitcoinPodManager.json"),
    "utf8"
  )
);
const avsDirectoryABI = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../abis/IAVSDirectory.json"), "utf8")
);

// Initialize contract objects from ABIs
const delegationManager = new ethers.Contract(
  delegationManagerAddress,
  delegationManagerABI,
  wallet
);
const bitDSMServiceManager = new ethers.Contract(
  bitDSMServiceManagerAddress,
  bitDSMServiceManagerABI,
  wallet
);
const bitDSMRegistryContract = new ethers.Contract(
  bitDSMRegistryAddress,
  bitDSMRegistryABI,
  wallet
);
const bitcoinPodManager = new ethers.Contract(
  bitcoinPodManagerAddress,
  bitcoinPodManagerABI,
  wallet
);
const avsDirectory = new ethers.Contract(
  avsDirectoryAddress,
  avsDirectoryABI,
  wallet
);

interface BitcoinDepositRequest {
  transactionId: string;
  amount: bigint;
  isPending: boolean;
}

const signAndRespondToTask = async (
  pod: string,
  operator: string,
  bitcoinDepositRequest: BitcoinDepositRequest
) => {
  const message = `${pod} ${operator} ${bitcoinDepositRequest.transactionId} ${bitcoinDepositRequest.amount} ${bitcoinDepositRequest.isPending}`;
  const messageHash = ethers.solidityPackedKeccak256(["string"], [message]);
  const messageBytes = ethers.getBytes(messageHash);
  const signature = await wallet.signMessage(messageBytes);

  console.log(`Signing and responding to task`);

  const operators = [await wallet.getAddress()];
  const signatures = [signature];

  const tx = await bitDSMServiceManager.confirmDeposit(pod, signature);
  await tx.wait();
  console.log(`Responded to task.`);
};

const registerOperator = async () => {
  // Registers as an Operator in EigenLayer.
  console.log(wallet.address);
  const registered_operator = await delegationManager.isOperator(
    wallet.address
  );
  if (registered_operator) {
    console.log("Operator already registered to Core EigenLayer contracts");
  } else {
    console.log("Registering Operator to EigenLayer contracts");

    console.log("======================");
    try {
      const tx1 = await delegationManager.registerAsOperator(
        {
          __deprecated_earningsReceiver: wallet.address,
          delegationApprover: wallet.address,
          stakerOptOutWindowBlocks: 0,
        },
        ""
      );

      console.log("======================");

      await tx1.wait();
      console.log("Operator registered to Core EigenLayer contracts");
    } catch (error) {
      console.error("Error in registering as operator:", error);
      // terminate execution
      process.exit(1);
    }
  }
  // check if operator is already registered to AVS
  const registered_operator_avs =
    await bitDSMRegistryContract.operatorRegistered(wallet.address);
  if (registered_operator_avs) {
    console.log("Operator already registered to AVS");
    return;
  } else {
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const expiry = Math.floor(Date.now() / 1000) + 3600; // Example expiry, 1 hour from now

    // prepare to register operator to AVS
    let operatorSignatureWithSaltAndExpiry = {
      signature: "",
      salt: salt,
      expiry: expiry,
    };

    // Calculate the digest hash, which is a unique value representing the operator, avs, unique value (salt) and expiration date.
    const operatorDigestHash =
      await avsDirectory.calculateOperatorAVSRegistrationDigestHash(
        wallet.address,
        await bitDSMServiceManager.getAddress(),
        salt,
        expiry
      );

    // Sign the digest hash with the operator's private key
    console.log("Signing digest hash with operator's private key");
    const operatorSigningKey = new ethers.SigningKey(process.env.PRIVATE_KEY!);
    const operatorSignedDigestHash =
      operatorSigningKey.sign(operatorDigestHash);

    // Encode the signature in the required format
    operatorSignatureWithSaltAndExpiry.signature = ethers.Signature.from(
      operatorSignedDigestHash
    ).serialized;

    console.log("Registering Operator to AVS Registry contract");
    // get the BTC public key of Operator from env
    const btcPublicKey = process.env.BTC_PUBLIC_KEY;
    console.log();
    if (!btcPublicKey) {
      throw new Error("BTC_PUBLIC_KEY environment variable is not set");
      console.log("====================333333==");
    }
    // Convert hex string to bytes array, removing '0x' prefix if present
    const btcPubKeyHex = btcPublicKey;
    const btcPublicKeyBytes = ethers.getBytes(btcPubKeyHex);
    console.log("======================");
    console.log("BTC public key bytes:", btcPublicKeyBytes);

    // Register Operator to AVS
    // Per release here: https://github.com/Layr-Labs/eigenlayer-middleware/blob/v0.2.1-mainnet-rewards/src/unaudited/ECDSAStakeRegistry.sol#L49
    const tx2 = await bitDSMRegistryContract.registerOperatorWithSignature(
      operatorSignatureWithSaltAndExpiry,
      wallet.address,
      btcPublicKeyBytes
    );
    await tx2.wait();
    console.log("Operator registered on AVS successfully");
    console.log("Operator address: ", wallet.address);
  }
};

// deregister operator
const deregisterOperator = async () => {
  try {
    const tx3 = await bitDSMRegistryContract.deregisterOperator();
    await tx3.wait();
    console.log("Operator deregistered from AVS successfully");
  } catch (error) {
    console.error("Error in deregistering operator:", error);
  }
};

const monitorNewTasks = async () => {
  console.log(`Creating a reference task for testing"`);
  // create a reference task for testing
  // random address for Pod
  const pod = "0x1234567890123456789012345678901234567890";
  // random transaction id
  const transactionId = "0x1234567890123456789012345678901234567890";
  // random amount
  const amount = 1000000;
  // get caller address
  const operator = await wallet.getAddress();
  await bitcoinPodManager.verifyBitcoinDepositRequest(
    pod,
    transactionId,
    amount
  );
  //await bitDSMServiceManager.createNewTask("EigenWorld");
  // create BitcoinDepositRequest object
  const bitcoinDepositRequest = {
    transactionId: transactionId,
    amount: amount,
    isPending: true,
  };
  // listen to the VerifyBitcoinDepositRequest event
  bitcoinPodManager.on(
    "VerifyBitcoinDepositRequest",
    async (pod: string, operator: string, bitcoinDepositRequest) => {
      console.log(`New task detected: Hello`);
      await signAndRespondToTask(pod, operator, bitcoinDepositRequest);
    }
  );

  console.log("Monitoring for new tasks...");
};

const main = async () => {
  await registerOperator();
  // await deregisterOperator();
  // monitorNewTasks().catch((error) => {
  //     console.error("Error monitoring tasks:", error);
  // });
};

main().catch((error) => {
  console.error("Error in main function:", error);
});
