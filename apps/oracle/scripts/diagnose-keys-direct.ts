import { ethers } from "ethers";
import { execSync } from "child_process";

async function run() {
    const parseEnv = (serviceName) => {
        try {
            const raw = execSync(`gcloud run services describe ${serviceName} --region=europe-west1 --format="json"`, { encoding: "utf8" });
            const data = JSON.parse(raw);
            const envs = data.spec.template.spec.containers[0].env || [];
            const result = {};
            for (const e of envs) {
                if (e.name.includes("KEY") || e.name.includes("PRIVATE") || e.name === "VALCORE_ADDRESS") {
                    result[e.name] = e.value;
                }
            }
            return result;
        } catch(e) {
            return { error: e.message };
        }
    };

    const oracleKeys = parseEnv("valcore-oracle-sepolia");
    const webKeys = parseEnv("valcore-web-sepolia");

    console.log("=== ORACLE ENVS ===");
    for (const [k, v] of Object.entries(oracleKeys)) {
        if (!v || v.startsWith("error") || k === "VALCORE_ADDRESS" || k === "NEXT_PUBLIC_VALCORE_ADDRESS") {
            console.log(`${k}: ${v}`);
            continue;
        }
        try {
            const w = new ethers.Wallet(v.trim());
            console.log(`${k}: Public Address: ${w.address}`);
        } catch(e) {
            console.log(`${k}: INVALID PRIVATE KEY FORMAT (${typeof v} len=${v?.length})`);
        }
    }

    console.log("\n=== WEB ENVS ===");
    for (const [k, v] of Object.entries(webKeys)) {
        if (!v || v.startsWith("error") || k === "VALCORE_ADDRESS" || k === "NEXT_PUBLIC_VALCORE_ADDRESS") {
            console.log(`${k}: ${v}`);
            continue;
        }
        try {
            const w = new ethers.Wallet(v.trim());
            console.log(`${k}: Public Address: ${w.address}`);
        } catch(e) {
            console.log(`${k}: INVALID PRIVATE KEY FORMAT (${typeof v} len=${v?.length})`);
        }
    }
}

run();
