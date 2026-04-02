import { ethers } from "ethers";

async function run() {
  const rpcs = [
    "https://rpc.sepolia.org",
    "https://sepolia.drpc.org",
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://rpc2.sepolia.org",
    "https://eth-sepolia.g.alchemy.com/v2/demo"
  ];
  const txHash = "0x563630e174c67abc8bde8641e33ee99d260798d47f3009090ac4d5c9128e355b";
  for (const r of rpcs) {
    try {
      const p = new ethers.JsonRpcProvider(r);
      const res = await p.getTransactionReceipt(txHash);
      if (res) console.log(`Found on ${r}: block ${res.blockNumber} status ${res.status}`);
      else console.log(`Not found on ${r}`);
    } catch(e) { 
      console.log(`Error on ${r}`);
    }
  }
}
run();
