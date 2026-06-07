// Warstwa abstrakcji nad OpenAI-compatible API.
// Konfiguracja: najpierw tabela `app_settings` w bazie (zarządzana z /admin),
// fallback do env vars (LLM_BASE_URL, LLM_API_KEY, CHAT_MODEL, EMBED_MODEL, TOP_K).
// Domyślnie: lokalna Ollama + gemma2:2b + nomic-embed-text.
import OpenAI from "openai";
import { query, queryOne, runStartupMigrations } from "./db.server";

export type LlmConfig = {
  baseURL: string;
  apiKey: string;
  chatModel: string;
  embedModel: string;
  embedBaseURL: string;
  embedApiKey: string;
  queryPrefix: string;
  topK: number;
};

// Models that require a prefix on queries (asymmetric retrieval).
const QUERY_PREFIXES: Record<string, string> = {
  "sdadas/mmlw-retrieval-roberta-large-v2": "[query]: ",
};

function detectQueryPrefix(model: string): string {
  return QUERY_PREFIXES[model] ?? "";
}

const DEFAULTS = {
  baseURL: "http://localhost:11434/v1",
  apiKey: "ollama",
  chatModel: "gemma4:26b",
  embedModel: "sdadas/mmlw-retrieval-roberta-large-v2",
  embedBaseURL: "http://tei:80/v1",
  embedApiKey: "tei",
  topK: 15,
};

let _cache: { config: LlmConfig; at: number } | null = null;
let _dimCache: { model: string; dim: number } | null = null;
const CACHE_MS = 5_000;

type SettingsRow = {
  llm_base_url: string | null;
  llm_api_key: string | null;
  chat_model: string | null;
  embed_model: string | null;
  embed_base_url: string | null;
  embed_api_key: string | null;
  top_k: number | null;
};

export async function getLlmConfig(): Promise<LlmConfig> {
  if (_cache && Date.now() - _cache.at < CACHE_MS) return _cache.config;

  await runStartupMigrations();

  let row: SettingsRow | null = null;
  try {
    row = await queryOne<SettingsRow>(
      `SELECT llm_base_url, llm_api_key, chat_model, embed_model, embed_base_url, embed_api_key, top_k
         FROM app_settings WHERE id = 1`,
    );
  } catch (e) {
    console.warn("[llm] cannot read app_settings, falling back to env:", e);
  }

  const envTopK = Number(process.env.TOP_K);
  const baseURL = row?.llm_base_url || process.env.LLM_BASE_URL || DEFAULTS.baseURL;
  const apiKey = row?.llm_api_key || process.env.LLM_API_KEY || DEFAULTS.apiKey;
  const embedModel = row?.embed_model || process.env.EMBED_MODEL || DEFAULTS.embedModel;
  const config: LlmConfig = {
    baseURL,
    apiKey,
    chatModel: row?.chat_model || process.env.CHAT_MODEL || DEFAULTS.chatModel,
    embedModel,
    embedBaseURL: row?.embed_base_url || process.env.EMBED_BASE_URL || DEFAULTS.embedBaseURL,
    embedApiKey: row?.embed_api_key || process.env.EMBED_API_KEY || DEFAULTS.embedApiKey,
    queryPrefix: detectQueryPrefix(embedModel),
    topK: row?.top_k ?? (Number.isFinite(envTopK) && envTopK > 0 ? envTopK : DEFAULTS.topK),
  };
  _cache = { config, at: Date.now() };
  return config;
}

export function invalidateLlmConfigCache() {
  _cache = null;
  _dimCache = null;
}

export async function openai(): Promise<OpenAI> {
  const cfg = await getLlmConfig();
  return new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
}

export async function getChatModel(): Promise<string> {
  return (await getLlmConfig()).chatModel;
}

async function ensureEmbedDim(model: string, dim: number): Promise<void> {
  if (_dimCache?.model === model && _dimCache.dim === dim) return;

  type AttrRow = { atttypmod: number };
  const row = await queryOne<AttrRow>(
    `SELECT atttypmod FROM pg_attribute
      WHERE attrelid = 'syllabus_chunks'::regclass AND attname = 'embedding' AND attnum > 0`,
  );
  // pg vector(N) stores N in atttypmod directly (no offset unlike varchar)
  const currentDim = row?.atttypmod ?? -1;

  if (currentDim !== dim) {
    console.log(`[embed] dimension change ${currentDim} → ${dim}, migrating DB…`);
    await query(`DROP INDEX IF EXISTS syllabus_chunks_embedding_idx`);
    await query(`ALTER TABLE syllabus_chunks ALTER COLUMN embedding TYPE vector(${dim})`);
    await query(`UPDATE syllabus_chunks SET embedding = NULL`);
    await query(`
      CREATE OR REPLACE FUNCTION match_syllabus_chunks(
        query_embedding   vector(${dim}),
        match_count       integer DEFAULT 5,
        filter_faculty    text DEFAULT NULL,
        filter_field      text DEFAULT NULL,
        filter_semester   text DEFAULT NULL
      ) RETURNS TABLE (
        id           uuid,
        syllabus_id  uuid,
        chunk_index  integer,
        content      text,
        similarity   real,
        faculty      text,
        field        text,
        semester     text,
        course_name  text,
        source_url   text
      ) LANGUAGE sql STABLE AS $$
        SELECT c.id, c.syllabus_id, c.chunk_index, c.content,
               (1 - (c.embedding <=> query_embedding))::real AS similarity,
               s.faculty, s.field, s.semester, s.course_name, s.source_url
          FROM syllabus_chunks c
          JOIN syllabi s ON s.id = c.syllabus_id
         WHERE s.status = 'ready'
           AND (filter_faculty  IS NULL OR s.faculty  = filter_faculty)
           AND (filter_field    IS NULL OR s.field    = filter_field)
           AND (filter_semester IS NULL OR s.semester = filter_semester)
         ORDER BY c.embedding <=> query_embedding
         LIMIT match_count;
      $$`);
    await query(
      `CREATE INDEX syllabus_chunks_embedding_idx
         ON syllabus_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`,
    );
    // Existing chunks have NULL embeddings now — mark syllabi for re-indexing.
    await query(`UPDATE syllabi SET status = 'pending', chunk_count = 0 WHERE status = 'ready'`);
    console.log(`[embed] migration done, syllabi marked pending for re-index`);
  }

  _dimCache = { model, dim };
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const cfg = await getLlmConfig();
  const client = new OpenAI({ apiKey: cfg.embedApiKey, baseURL: cfg.embedBaseURL });
  const res = await client.embeddings.create({
    model: cfg.embedModel,
    input: texts,
  });
  const vecs = res.data.map((d) => d.embedding as number[]);
  await ensureEmbedDim(cfg.embedModel, vecs[0].length);
  return vecs;
}

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embed([text]);
  return v;
}

/** Like embedOne but prepends the model's query prefix (e.g. "[query]: " for mmlw). */
export async function embedQuery(text: string): Promise<number[]> {
  const cfg = await getLlmConfig();
  return embedOne(cfg.queryPrefix + text);
}
