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
  top_k: z.number().int().min(1).max(50),
});

export const getSettings = createServerFn({ method: "GET" }).handler(async () => {
  const cfg = await getLlmConfig();
  return {
    llm_base_url: cfg.baseURL,
    llm_api_key_masked: cfg.apiKey ? cfg.apiKey.slice(0, 3) + "•••••" : "",
    chat_model: cfg.chatModel,
    embed_model: cfg.embedModel,
    top_k: cfg.topK,
  };
});

export const updateSettings = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => SettingsInput.parse(d))
  .handler(async ({ data }) => {
    const keepApiKey = data.llm_api_key === "__keep__";
    if (keepApiKey) {
      await query(
        `UPDATE app_settings
            SET llm_base_url = $1,
                chat_model   = $2,
                embed_model  = $3,
                top_k        = $4,
                updated_at   = now()
          WHERE id = 1`,
        [data.llm_base_url, data.chat_model, data.embed_model, data.top_k],
      );
    } else {
      await query(
        `UPDATE app_settings
            SET llm_base_url = $1,
                llm_api_key  = $2,
                chat_model   = $3,
                embed_model  = $4,
                top_k        = $5,
                updated_at   = now()
          WHERE id = 1`,
        [
          data.llm_base_url,
          data.llm_api_key,
          data.chat_model,
          data.embed_model,
          data.top_k,
        ],
      );
    }
    invalidateLlmConfigCache();
    return { ok: true };
  });
