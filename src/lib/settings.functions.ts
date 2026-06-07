import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query } from "./db.server";
import { invalidateLlmConfigCache, getLlmConfig } from "./openai.server";

const SettingsInput = z.object({
  llm_base_url: z.string().trim().min(1).max(500).nullable(),
  // Specjalna wartość "__keep__" = nie zmieniaj klucza (UI wysyła ją gdy pole puste).
  llm_api_key: z.string().trim().min(1).max(500).nullable(),
  chat_model: z.string().trim().min(1).max(200).nullable(),
  embed_model: z.string().trim().min(1).max(200).nullable(),
  // Pusty string / null = dziedzicz z llm_base_url / llm_api_key.
  embed_base_url: z.string().trim().max(500).nullable(),
  embed_api_key: z.string().trim().max(500).nullable(),
  top_k: z.number().int().min(1).max(50),
});

export const getSettings = createServerFn({ method: "GET" }).handler(async () => {
  const cfg = await getLlmConfig();
  const embedBaseURLExplicit = cfg.embedBaseURL !== cfg.baseURL ? cfg.embedBaseURL : "";
  const embedApiKeyExplicit = cfg.embedApiKey !== cfg.apiKey ? cfg.embedApiKey : "";
  return {
    llm_base_url: cfg.baseURL,
    llm_api_key_masked: cfg.apiKey ? cfg.apiKey.slice(0, 3) + "•••••" : "",
    chat_model: cfg.chatModel,
    embed_model: cfg.embedModel,
    embed_base_url: embedBaseURLExplicit,
    embed_api_key_masked: embedApiKeyExplicit ? embedApiKeyExplicit.slice(0, 3) + "•••••" : "",
    top_k: cfg.topK,
  };
});

export const updateSettings = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => SettingsInput.parse(d))
  .handler(async ({ data }) => {
    await query(
      `UPDATE app_settings
          SET llm_base_url   = $1,
              llm_api_key    = CASE WHEN $2 = '__keep__' THEN llm_api_key ELSE $2::text END,
              chat_model     = $3,
              embed_model    = $4,
              embed_base_url = NULLIF($5, ''),
              embed_api_key  = CASE WHEN $6 = '__keep__' THEN embed_api_key ELSE NULLIF($6, '')::text END,
              top_k          = $7,
              updated_at     = now()
        WHERE id = 1`,
      [
        data.llm_base_url,
        data.llm_api_key ?? null,
        data.chat_model,
        data.embed_model,
        data.embed_base_url ?? "",
        data.embed_api_key ?? null,
        data.top_k,
      ],
    );
    invalidateLlmConfigCache();
    return { ok: true };
  });
