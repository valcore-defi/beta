import { ethers } from "ethers";

async function run() {
  const p = new ethers.JsonRpcProvider("https://kopli-rpc.reactive.network");
  const txHash = "0x563630e174c67abc8bde8641e33ee99d260798d47f3009090ac4d5c9128e355b";
  try {
    const t = await p.getTransaction(txHash);
    if (!t) {
      console.log("Transaction not found on Kopli network.");
    } else {
      console.log("Found on Kopli! Block:", t.blockNumber);
      const r = await p.getTransactionReceipt(txHash);
      console.log("Receipt Status:", r ? (r.status === 1 ? "SUCCESS" : "REVERTED") : "null");
      if (r && r.status !== 1) {
         console.log("Transaction Reverted on Kopli!");
      }
    }
    
    const executor = "0x00a03955454427953CC8947f23CF04269cAb38EE";
    console.log("Kopli Balance for executor:", ethers.formatEther(await p.getBalance(executor)));
  } catch(e) {
    console.log("Error:", e.message);
  }
}
run();
