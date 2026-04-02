import { ethers } from "ethers";

async function run() {
  const p = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com"); // standard public node
  const txHash = "0x563630e174c67abc8bde8641e33ee99d260798d47f3009090ac4d5c9128e355b";
  try {
    const t = await p.getTransaction(txHash);
    if (!t) {
      console.log("Transaction not found in mempool or chain.");
      // Check deployer nonce to see what the current mined nonce is
      const deployer = "0x9E021EC1d5a3EF8790Ed7eC7b32f0936f30ED020";
      const nonce = await p.getTransactionCount(deployer);
      console.log("Current deployer onchain nonce:", nonce);
    } else {
      console.log("Found Transaction!");
      console.log("Mined?", t.blockNumber ? "YES in block " + t.blockNumber : "NO (PENDING)");
      console.log("Nonce:", t.nonce);
      console.log("GasLimit:", t.gasLimit.toString());
      console.log("MaxFee:", ethers.formatUnits(t.maxFeePerGas || 0n, "gwei"));
    }
  } catch(e) {
    console.log("Error:", e.message);
  }
}
run();
