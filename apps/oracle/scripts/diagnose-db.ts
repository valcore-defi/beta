import pg from "pg";

async function run() {
  const pool = new pg.Pool({
    connectionString: "postgresql://app_read:KhxMM*9QoWia_B_jPqbi@127.0.0.1:5432/valcore-sepolia-testnet",
  });
  
  try {
    console.log("=== RECENT LIFECYCLE INTENTS ===");
    const intents = await pool.query("SELECT id, operation, status, target_status, details_json, error_message, updated_at FROM lifecycle_intents ORDER BY id DESC LIMIT 5");
    console.table(intents.rows);

    console.log("\n=== RECENT SELF HEAL TASKS ===");
    const heals = await pool.query("SELECT id, task_type, status, attempt_count, last_error_message, next_attempt_at FROM self_heal_tasks ORDER BY id DESC LIMIT 5");
    console.table(heals.rows);

    console.log("\n=== RECENT SELF HEAL TASK RUNS ===");
    const runs = await pool.query("SELECT id, task_id, status, error_message, finished_at FROM self_heal_task_runs ORDER BY id DESC LIMIT 5");
    console.table(runs.rows);
  } catch(e) {
    console.log("Error:", e.message);
  } finally {
    await pool.end();
  }
}

run();
