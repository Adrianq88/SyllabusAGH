import "@tanstack/react-start";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { query, toVectorLiteral } from "@/lib/db.server";
import { openai, getChatModel, embedQuery, getLlmConfig } from "@/lib/openai.server";

const Body = z.object({
  session_id: z.string().min(1).max(128),
  message: z.string().min(1).max(4000),
  filters: z
    .object({
      faculty: z.string().optional().nullable(),
      field: z.string().optional().nullable(),
      semester: z.string().optional().nullable(),
      syllabus_id: z.string().uuid().optional().nullable(),
    })
    .optional(),
});

type Source = {
  syllabus_id: string;
  course_name: string;
  faculty: string;
  field: string;
  semester: string;
  source_url: string | null;
  chunk_index: number;
  similarity: number;
};

type MatchRow = {
  id: string;
  syllabus_id: string;
  chunk_index: number;
  content: string;
  similarity: number;
  faculty: string;
  field: string;
  semester: string;
  course_name: string;
  source_url: string | null;
};

const SYSTEM_PROMPT = `Jesteś asystentem "Ask Sylabus AGH". Odpowiadasz wyłącznie na podstawie dostarczonych fragmentów sylabusów AGH.
KRYTYCZNE: ZAWSZE odpowiadaj w języku POLSKIM, niezależnie od języka pytania, kontekstu czy fragmentów. NIGDY nie używaj angielskiego. Wszystkie zdania, nagłówki, listy i komentarze muszą być po polsku.
Zasady:
- Odpowiadaj zwięźle, po polsku, w stylu rzeczowym.
- Jeśli pytanie jest ogólne (np. "hej", "cześć"), przywitaj się krótko po polsku i zapytaj o co konkretnie chodzi — NIE streszczaj kontekstu.
- Jeśli kontekst nie zawiera odpowiedzi, powiedz wprost: "Nie znalazłem tego w sylabusach".
- Jeśli pytanie ma więcej niż jedną poprawną odpowiedź, na przykład przedmiot występuje na więcej niż jednym kierunku, lub prowadzący zajmuje się więcej niż jednym przedmiotem, lub przedmiot różnił się w poszczególnych rocznikach - wyjaśnij to użytkownikowim, podając wszystkie istotne informacje.
- Zawsze udzielaj odpowiedzi. Pusta odpowiedź nie jest dozwolona. Jeżeli nie znasz poprawnej odpowiedzi, po prostu przyznaj się do tego.
- Cytuj numery źródeł w formacie [1], [2] przy konkretnych faktach.
- Nie zmyślaj nazw przedmiotów, prowadzących, punktów ECTS ani godzin.`;

const MAX_CONTEXT_CHARS_PER_SOURCE = 900;

function trimContextChunk(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_CONTEXT_CHARS_PER_SOURCE) return normalized;
  return `${normalized.slice(0, MAX_CONTEXT_CHARS_PER_SOURCE).trimEnd()}…`;
}

function buildContext(sources: Source[], contents: string[]): string {
  return sources
    .map(
      (s, i) =>
        `[${i + 1}] ${s.course_name} — ${s.faculty} / ${s.field} / sem. ${s.semester}\n${trimContextChunk(contents[i] ?? "")}`,
    )
    .join("\n\n---\n\n");
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sseErrorResponse(error: unknown): Response {
  const encoder = new TextEncoder();
  const msg = toErrorMessage(error);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(msg)}\n\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

async function insertMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  sources: Source[],
) {
  await query(
    `INSERT INTO chat_messages (session_id, role, content, sources)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [sessionId, role, content, JSON.stringify(sources)],
  );
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch (e) {
          return new Response(
            JSON.stringify({ error: e instanceof Error ? e.message : "Invalid body" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        try {
          // Pobierz ostatnie wiadomości (kontekst rozmowy) ZANIM zapiszemy bieżącą.
          const historyRows = await query<{ role: "user" | "assistant"; content: string }>(
            `SELECT role, content FROM chat_messages
              WHERE session_id = $1
              ORDER BY created_at DESC
              LIMIT 6`,
            [body.session_id],
          );
          const history = historyRows.reverse();

          await insertMessage(body.session_id, "user", body.message, []);

          // Detekcja krótkich pozdrowień / small-talku — pomijamy RAG, żeby model nie zmyślał.
          const normalized = body.message.trim().toLowerCase().replace(/[!?.,]+$/g, "");
          const GREETINGS = new Set([
            "hej", "cześć", "czesc", "siema", "witaj", "witam", "dzień dobry",
            "dzien dobry", "dobry wieczór", "dobry wieczor", "yo", "hi", "hello",
            "co potrafisz", "co umiesz", "kim jesteś", "kim jestes", "pomoc", "help",
          ]);
          const isSmallTalk = normalized.length <= 25 && GREETINGS.has(normalized);

          if (isSmallTalk) {
            const quickReply = "Cześć! Zapytaj mnie o konkretny przedmiot, efekty uczenia, ECTS, treści zajęć albo formę zaliczenia z sylabusów AGH.";
            await insertMessage(body.session_id, "assistant", quickReply, []);

            const encoder = new TextEncoder();
            const sse = new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(`event: sources\ndata: []\n\n`));
                controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify(quickReply)}\n\n`));
                controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
                controller.close();
              },
            });

            return new Response(sse, {
              headers: {
                "content-type": "text/event-stream",
                "cache-control": "no-cache, no-transform",
                "x-accel-buffering": "no",
              },
            });
          }

          let rows: MatchRow[] = [];

          const qVec = await embedQuery(body.message);
          const cfg = await getLlmConfig();
          const topK = cfg.topK;

          if (body.filters?.syllabus_id) {
            rows = await query<MatchRow>(
              `SELECT c.id, c.syllabus_id, c.chunk_index, c.content,
                      1 - (c.embedding <=> $1::vector) AS similarity,
                      s.faculty, s.field, s.semester, s.course_name, s.source_url
                 FROM syllabus_chunks c
                 JOIN syllabi s ON s.id = c.syllabus_id
                WHERE c.syllabus_id = $2
                ORDER BY c.embedding <=> $1::vector
                LIMIT $3`,
              [toVectorLiteral(qVec), body.filters.syllabus_id, topK],
            );
            if (rows.length === 0) {
              return sseErrorResponse("Nie znaleziono przedmiotu");
            }
          } else {
            // Hybrydowo: keyword po nazwie przedmiotu + wektor.
            const STOP = new Set([
              "kto","co","jak","jakie","jaki","jaka","gdzie","kiedy","czy","ile","dla",
              "jest","są","sa","to","ten","ta","te","tego","tej","tych","tym",
              "prowadzącym","prowadzacym","prowadzący","prowadzacy","prowadzi","wykładowca","wykladowca",
              "przedmiot","przedmiotu","kurs","kursu","sylabus","sylabusie","zajęcia","zajecia",
              "ects","godzin","godziny","punkty","punktów","forma","zaliczenia","zaliczenie",
              "efekty","uczenia","się","sie","oraz","albo","lub",
              "the","and","for","with",
            ]);
            const tokens = body.message
              .toLowerCase()
              .replace(/[?.,!:;()"„""''`]/g, " ")
              .split(/\s+/)
              .filter((t) => t.length >= 3 && !STOP.has(t));

            let keywordRows: MatchRow[] = [];
            if (tokens.length > 0) {
              const bigrams: string[] = [];
              for (let i = 0; i < tokens.length - 1; i++) {
                bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
              }
              const allPhrases = [...bigrams, ...tokens];
              const params: unknown[] = [
                toVectorLiteral(qVec),
                body.filters?.faculty ?? null,
                body.filters?.field ?? null,
                body.filters?.semester ?? null,
              ];
              const clauses: string[] = [];
              // Match po nazwie przedmiotu (bigramy + pojedyncze tokeny).
              for (const p of allPhrases) {
                params.push(`%${p}%`);
                clauses.push(`s.course_name ILIKE $${params.length}`);
              }
              // Match po treści chunku — tylko bigramy (np. imię+nazwisko prowadzącego),
              // żeby nie łapać pojedynczych pospolitych słów.
              for (const p of bigrams) {
                params.push(`%${p}%`);
                clauses.push(`c.content ILIKE $${params.length}`);
              }
              const likeClauses = clauses.join(" OR ");
              keywordRows = await query<MatchRow>(
                `SELECT c.id, c.syllabus_id, c.chunk_index, c.content,
                        1 - (c.embedding <=> $1::vector) AS similarity,
                        s.faculty, s.field, s.semester, s.course_name, s.source_url
                   FROM syllabus_chunks c
                   JOIN syllabi s ON s.id = c.syllabus_id
                  WHERE (${likeClauses})
                    AND ($2::text IS NULL OR s.faculty = $2)
                    AND ($3::text IS NULL OR s.field = $3)
                    AND ($4::text IS NULL OR s.semester = $4)
                  ORDER BY c.embedding <=> $1::vector
                  LIMIT ${topK}`,
                params,
              );
            }

            const vectorRows = await query<MatchRow>(
              `SELECT * FROM match_syllabus_chunks($1::vector, $2, $3, $4, $5)`,
              [
                toVectorLiteral(qVec),
                topK,
                body.filters?.faculty ?? null,
                body.filters?.field ?? null,
                body.filters?.semester ?? null,
              ],
            );

            const seen = new Set<string>();
            rows = [];
            for (const r of [...keywordRows, ...vectorRows]) {
              if (seen.has(r.id)) continue;
              seen.add(r.id);
              rows.push(r);
              if (rows.length >= topK) break;
            }
          }

          const sources: Source[] = rows.map((r) => ({
            syllabus_id: r.syllabus_id,
            course_name: r.course_name,
            faculty: r.faculty,
            field: r.field,
            semester: r.semester,
            source_url: r.source_url,
            chunk_index: r.chunk_index,
            similarity: r.similarity,
          }));
          const contents = rows.map((r) => r.content);

          const context = isSmallTalk
            ? "(Powitanie użytkownika — brak kontekstu z sylabusów. Przywitaj się krótko po polsku i zapytaj, o jaki przedmiot lub temat chce zapytać. NIE WYMYŚLAJ żadnych nazw przedmiotów ani treści.)"
            : sources.length
            ? buildContext(sources, contents)
            : "(Brak dopasowanych fragmentów w bazie sylabusów.)";

          const client = await openai();
          const chatModel = await getChatModel();
          const messages = [
            { role: "system" as const, content: SYSTEM_PROMPT },
            ...history.map((h) => ({ role: h.role, content: h.content })),
            {
              role: "user" as const,
              content: `Pytanie: ${body.message}\n\nKontekst (fragmenty sylabusów):\n${context}`,
            },
          ];
          // OpenAI API: max_tokens = total sequence length (prompt + response).
          // Estimate prompt tokens (chars/4) and add 350 for the response budget.
          const promptTokens = messages.reduce((s, m) => s + m.content.length, 0);
          const maxTokens = promptTokens + 1024;
          console.log("[chat] sending to LLM model=%s sources=%d prompt_tokens~=%d max_tokens=%d", chatModel, sources.length, promptTokens, maxTokens);
          const stream = await client.chat.completions.create({
            model: chatModel,
            stream: true,
            temperature: 0.1,
            max_tokens: maxTokens,
            messages,
          });

        const encoder = new TextEncoder();
        let assistantBuf = "";

        const sse = new ReadableStream({
          async start(controller) {
            controller.enqueue(
              encoder.encode(`event: sources\ndata: ${JSON.stringify(sources)}\n\n`),
            );
            try {
              for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta?.content || "";
                const finishReason = chunk.choices[0]?.finish_reason;
                if (delta) {
                  assistantBuf += delta;
                  controller.enqueue(
                    encoder.encode(`event: delta\ndata: ${JSON.stringify(delta)}\n\n`),
                  );
                }
                if (finishReason) console.log("[chat] finish_reason=%s buf_len=%d", finishReason, assistantBuf.length);
              }
              console.log("[chat] stream done buf_len=%d", assistantBuf.length);
              controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              controller.enqueue(
                encoder.encode(`event: error\ndata: ${JSON.stringify(msg)}\n\n`),
              );
            } finally {
              if (assistantBuf) {
                try {
                  await insertMessage(body.session_id, "assistant", assistantBuf, sources);
                } catch (err) {
                  console.error("[chat] failed to save assistant message:", err);
                }
              }
              controller.close();
            }
          },
        });

        return new Response(sse, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          },
        });
        } catch (err) {
          console.error("[chat] request failed:", err);
          return sseErrorResponse(err);
        }
      },
    },
  },
});
