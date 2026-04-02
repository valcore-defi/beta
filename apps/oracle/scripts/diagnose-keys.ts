import { ethers } from "ethers";
import * as fs from "fs";

async function run() {
    const parseEnv = (filename) => {
        try {
            const data = JSON.parse(fs.readFileSync(filename, "utf8"));
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

    const oracleKeys = parseEnv("oracle-env-utf8.json");
    const webKeys = parseEnv("web-env-utf8.json");

    console.log("=== ORACLE ENVS ===");
    for (const [k, v] of Object.entries(oracleKeys)) {
        if (!v || v.startsWith("error") || k === "VALCORE_ADDRESS" || k === "NEXT_PUBLIC_VALCORE_ADDRESS") {
            console.log(`${k}: ${v}`);
            continue;
        }
        try {
            const w = new ethers.Wallet(v.trim());
            console.log(`${k}: Public Address: ${w.address} (Length: ${v.length})`);
        } catch(e) {
            console.log(`${k}: INVALID PRIVATE KEY FORMAT (${typeof v} len=${v?.length}) -> Error: ${e.message}`);
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
            console.log(`${k}: Public Address: ${w.address} (Length: ${v.length})`);
        } catch(e) {
            console.log(`${k}: INVALID PRIVATE KEY FORMAT (${typeof v} len=${v?.length}) -> Error: ${e.message}`);
        }
    }
}

run();
