import pg from "pg";
import { writeFileSync } from "fs";

async function run() {
  const pool = new pg.Pool({ connectionString: "postgresql://app_read:KhxMM*9QoWia_B_jPqbi@127.0.0.1:5432/valcore-sepolia-testnet" });
  try {
    const intents = await pool.query("SELECT id, op_key, operation, status, tx_hash, details_json, last_error FROM lifecycle_tx_intents ORDER BY id DESC LIMIT 5");
    const weeks = await pool.query("SELECT id, status FROM weeks ORDER BY id DESC LIMIT 2");
    
    const out = {
      weeks: weeks.rows,
      intents: intents.rows
    };
    writeFileSync("live-db-errors.json", JSON.stringify(out, null, 2));
  } catch(e) {
    writeFileSync("live-db-errors.json", JSON.stringify({ error: e.message }));
  } finally {
    await pool.end();
  }
}
run();
