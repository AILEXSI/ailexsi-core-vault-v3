import postgres from "postgres";

const urls = [
  process.env.CORE_DATABASE_URL,
  process.env.DATABASE_URL,
  "postgres://ailexsi:ailexsi@127.0.0.1:5432/ailexsi",
  "postgres://ailexsi:ailexsi@localhost:5432/ailexsi",
  "postgres://postgres:postgres@127.0.0.1:5432/postgres",
  "postgres://postgres@127.0.0.1:5432/postgres",
].filter(Boolean);

let anyOk = false;
for (const url of urls) {
  const safe = url.replace(/:[^:@/]+@/, ":***@");
  const sql = postgres(url, { max: 1, connect_timeout: 3 });
  try {
    const r = await sql`select current_database() as db, current_user as u`;
    console.log("OK", safe, "db=", r[0].db, "user=", r[0].u);
    anyOk = true;
    await sql.end({ timeout: 1 });
  } catch (e) {
    console.log("FAIL", safe, String(e.message || e).slice(0, 160));
    try {
      await sql.end({ timeout: 1 });
    } catch {
      /* ignore */
    }
  }
}
process.exit(anyOk ? 0 : 2);
