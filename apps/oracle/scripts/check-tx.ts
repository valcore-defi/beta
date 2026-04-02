import { ethers } from "ethers";

async function run() {
  const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
  const txHash = "0x563630e174c67abc8bde8641e33ee99d260798d47f3009090ac4d5c9128e355b";
  try {
    console.log("Fetching receipt...");
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      console.log("Tx not found on Sepolia! (Might be Kopli or dropped)");
    } else {
      console.log("To:", receipt.to);
      console.log("Status:", receipt.status === 1 ? "SUCCESS" : "REVERTED");
      
      const logs = receipt.logs;
      console.log("Logs count:", logs.length);
    }
  } catch(e) {
    console.log("Error:", e.message);
  }
}
run();
