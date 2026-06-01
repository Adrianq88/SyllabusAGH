// Warstwa abstrakcji nad OpenAI-compatible API.
// Konfiguracja: najpierw tabela `app_settings` w bazie (zarządzana z /admin),
// fallback do env vars (LLM_BASE_URL, LLM_API_KEY, CHAT_MODEL, EMBED_MODEL, TOP_K).
// Domyślnie: lokalna Ollama + gemma2:2b + nomic-embed-text.
import OpenAI from "openai";
import { queryOne } from "./db.server";

export type LlmConfig = {
  baseURL: string;
  apiKey: string;
  chatModel: string;
  embedModel: string;
  topK: number;
};

const DEFAULTS = {
  baseURL: "http://localhost:11434/v1",
  apiKey: "ollama",
  chatModel: "qwen2.5:3b",
  embedModel: "nomic-embed-text",
  topK: 5,
};

export const EMBED_DIM = 768;

let _cache: { config: LlmConfig; at: number } | null = null;
const CACHE_MS = 5_000;

type SettingsRow = {
  llm_base_url: string | null;
  llm_api_key: string | null;
  chat_model: string | null;
  embed_model: string | null;
  top_k: number | null;
};

export async function getLlmConfig(): Promise<LlmConfig> {
  if (_cache && Date.now() - _cache.at < CACHE_MS) return _cache.config;

  let row: SettingsRow | null = null;
  try {
    row = await queryOne<SettingsRow>(
      `SELECT llm_base_url, llm_api_key, chat_model, embed_model, top_k
         FROM app_settings WHERE id = 1`,
    );
  } catch (e) {
    console.warn("[llm] cannot read app_settings, falling back to env:", e);
  }

  const envTopK = Number(process.env.TOP_K);
  const config: LlmConfig = {
    baseURL: row?.llm_base_url || process.env.LLM_BASE_URL || DEFAULTS.baseURL,
    apiKey: row?.llm_api_key || process.env.LLM_API_KEY || DEFAULTS.apiKey,
    chatModel: row?.chat_model || process.env.CHAT_MODEL || DEFAULTS.chatModel,
    embedModel: row?.embed_model || process.env.EMBED_MODEL || DEFAULTS.embedModel,
    topK: row?.top_k ?? (Number.isFinite(envTopK) && envTopK > 0 ? envTopK : DEFAULTS.topK),
  };
  _cache = { config, at: Date.now() };
  return config;
}

export function invalidateLlmConfigCache() {
  _cache = null;
}

export async function openai(): Promise<OpenAI> {
  const cfg = await getLlmConfig();
  return new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
}

export async function getChatModel(): Promise<string> {
  return (await getLlmConfig()).chatModel;
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const cfg = await getLlmConfig();
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
  // `dimensions` obsługują tylko modele OpenAI text-embedding-3-*; Ollama je ignoruje.
  const useDimensions = cfg.embedModel.startsWith("text-embedding-3");
  const res = await client.embeddings.create({
    model: cfg.embedModel,
    input: texts,
    ...(useDimensions ? { dimensions: EMBED_DIM } : {}),
  });
  return res.data.map((d) => d.embedding as number[]);
}

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embed([text]);
  return v;
}
