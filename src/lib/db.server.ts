// Pool połączeń do lokalnego Postgresa (pgvector).
// Konfiguracja przez `DATABASE_URL` w .env (np. postgres://sylabus:sylabus@postgres:5432/sylabus).
import { Pool, type QueryResultRow } from "pg";

let _pool: Pool | undefined;

function getPool(): Pool {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL nie jest ustawione — uzupełnij .env i uruchom `docker compose up`",
      );
    }
    _pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    _pool.on("error", (err) => console.error("[db] pool error:", err));
  }
  return _pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await getPool().query<T>(text, params as never);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Pomocnik: zamienia tablicę numerów na literal pgvector `[1,2,3]`. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

let _migrationsRan = false;

export async function runStartupMigrations(): Promise<void> {
  if (_migrationsRan) return;
  _migrationsRan = true;
  try {
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS embed_base_url text`);
    await query(`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS embed_api_key text`);
  } catch (e) {
    console.error("[db] startup migration failed:", e);
    _migrationsRan = false;
  }
}
