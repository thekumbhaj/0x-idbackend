const Web3 = require('web3');
require('dotenv').config();

// Web3.js Setup
const web3 = new Web3(process.env.AMOY_RPC_URL);

const contractABI = [
  {
    inputs: [
      { name: 'userWallet', type: 'address' },
      { name: 'kycHash', type: 'bytes32' },
    ],
    name: 'approveKYC',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

const contract = new web3.eth.Contract(contractABI, process.env.CONTRACT_ADDRESS);

// Helper Function to Hash KYC Data using web3.utils.sha3
const hashKYCData = (username, frontIdText, backIdText) => {
  const combinedData = `${username}${frontIdText}${backIdText}`;
  return web3.utils.sha3(combinedData); // Already returns 0x-prefixed hex string
};

// Approve KYC On-Chain
const approveKYC = async (walletAddress, fullName, frontIdText, backIdText) => {
  try {
    const kycHash = hashKYCData(fullName, frontIdText, backIdText);
    console.log('Generated KYC Hash:', kycHash);

    const adminAccount = web3.eth.accounts.privateKeyToAccount(process.env.PRIVATE_KEY);
    web3.eth.accounts.wallet.add(adminAccount);

    const txData = contract.methods.approveKYC(walletAddress, kycHash).encodeABI();
    const gas = await contract.methods.approveKYC(walletAddress, kycHash).estimateGas({ from: adminAccount.address });
    const gasPrice = await web3.eth.getGasPrice();

    const tx = {
      from: adminAccount.address,
      to: process.env.CONTRACT_ADDRESS,
      gas,
      gasPrice,
      data: txData,
    };

    const signedTx = await web3.eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY);
    const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);

    console.log('Transaction Hash:', receipt.transactionHash);
    return { success: true, txHash: receipt.transactionHash };
  } catch (error) {
    console.error('Web3 Approve KYC error:', error.message);
    throw new Error(`Failed to approve KYC on-chain: ${error.message}`);
  }
};

module.exports = { approveKYC };