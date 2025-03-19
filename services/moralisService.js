const Moralis = require('moralis').default;

const initializeMoralis = async () => {
  await Moralis.start({ apiKey: process.env.MORALIS_API_KEY });
};

const getAssetTransfers = async (walletAddress, fromDate, toDate) => {
  const response = await Moralis.EvmApi.transaction.getWalletTransactions({
    chain: '0x13882',
    address: walletAddress,
    fromDate: fromDate.toISOString().split('T')[0],
    toDate: toDate.toISOString().split('T')[0],
  });
  return response.result;
};


module.exports = { initializeMoralis, getAssetTransfers };