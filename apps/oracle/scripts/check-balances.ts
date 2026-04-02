import { ethers } from "ethers";

async function run() {
  const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
  const deployer = "0x9E021EC1d5a3EF8790Ed7eC7b32f0936f30ED020";
  const executor = "0x00a03955454427953CC8947f23CF04269cAb38EE";

  try {
    const b1 = await provider.getBalance(deployer);
    console.log("Deployer Balance (0x9E02...):", ethers.formatEther(b1), "ETH");

    const b2 = await provider.getBalance(executor);
    console.log("Reactive Executor (0x00a0...):", ethers.formatEther(b2), "ETH");
  } catch(e) {
    console.log("Error:", e.message);
  }
}
run();
