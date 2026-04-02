import pg from "pg";

async function run() {
  const pool = new pg.Pool({
    connectionString: "postgresql://app_read:KhxMM*9QoWia_B_jPqbi@127.0.0.1:5432/valcore-sepolia-testnet",
  });
  
  try {
    console.log("=== LIFECYCLE TX INTENT ===");
    const res = await pool.query("SELECT id, op_key, operation, status, last_error FROM lifecycle_tx_intents ORDER BY id DESC LIMIT 5");
    console.log(res.rows);
  } catch(e) {
    console.log("Error:", e.message);
  } finally {
    await pool.end();
  }
}

run();
