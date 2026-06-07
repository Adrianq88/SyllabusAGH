# Ask Sylabus AGH

Lokalny chatbot RAG (Retrieval-Augmented Generation) odpowiadający na pytania o sylabusy AGH na podstawie oficjalnych kart przedmiotów z `sylabusy.agh.edu.pl`.

**Stack:** TanStack Start (React 19 + Node SSR), Postgres + pgvector, Ollama (lokalny LLM), Docker Compose.

## Szybki start (krok po kroku)

Wymagane: Docker + Docker Compose, ~4 GB wolnego RAM, ~10 GB miejsca na dysku.

**1. Sklonuj repo**

```bash
git clone <repo>
cd <repo>
```

**2. Skonfiguruj `.env`**

```bash
cp .env.example .env
```

Domyślne wartości działają od ręki (Postgres + Ollama lokalnie, hasło `sylabus`). Możesz zmienić:
- `POSTGRES_PASSWORD` — hasło do bazy (warto zmienić przed wystawieniem na sieć)
- `PORT` — port aplikacji (domyślnie `8080`)
- `CHAT_MODEL` / `EMBED_MODEL` — modele LLM
- `LLM_BASE_URL` + `LLM_API_KEY` — jeśli wolisz OpenAI/Groq zamiast lokalnej Ollamy (przykład w `.env.example`)

**3. Postaw kontenery**

```bash
docker compose up --build -d       # pierwsze uruchomienie: ~3-5 min
```

Startuje 3 usługi: `postgres` (baza + pgvector), `ollama` (lokalny LLM), `app` (TanStack Start).

**4. Pobierz modele Ollamy (jednorazowo, ~20 GB)**

```bash
docker compose exec ollama ollama pull gemma4:26b
docker compose exec ollama ollama pull nomic-embed-text
```

**5. Otwórz aplikację**

http://localhost:8080

### Checklista weryfikacji

Po `docker compose up` sprawdź, że wszystko gra:

- [ ] `docker compose ps` — trzy usługi w stanie `running` / `healthy`
- [ ] http://localhost:8080 — ładuje się strona czatu
- [ ] http://localhost:8080/admin — ładuje się panel administracyjny
- [ ] `curl http://localhost:11434/api/tags` — Ollama odpowiada listą pobranych modeli (musi zawierać `gemma4:26b` i `nomic-embed-text`)
- [ ] `docker compose exec postgres psql -U sylabus -d sylabus -c "\dt"` — widać tabele `syllabi`, `syllabus_chunks`, `chat_messages`, `app_settings`
- [ ] W `/admin` → "Ustawienia LLM" pola są wypełnione (`http://ollama:11434/v1`, `gemma4:26b`, `nomic-embed-text`)

Jeśli któryś krok nie przechodzi → `docker compose logs <usługa>` (np. `docker compose logs app`).

## Pierwsze użycie

1. Wejdź na `/admin`.
2. W sekcji "Importuj cały kierunek" wklej URL kierunku z `sylabusy.agh.edu.pl` (np. `https://sylabusy.agh.edu.pl/pl/1/2/22/1/5/4/113`) i kliknij **Importuj wszystko**. Aplikacja przejdzie po wszystkich przedmiotach, pobierze karty HTML i zaindeksuje je (chunking + embeddingi).
3. Wróć na `/` i pytaj.

## Konfiguracja modeli

Panel `/admin` → karta "Ustawienia LLM". Można zmienić bazę URL, klucz API, model czatu, model embeddingów i top-k bez restartu. Zmiana modelu embeddingów wymaga ponownej indeksacji (embeddingi z różnych modeli nie są porównywalne).

Wbudowane dla:
- **Ollama** (domyślnie) — w pełni lokalnie, bez kluczy
- **OpenAI** — przykład w `.env.example`
- dowolny inny endpoint OpenAI-compatible (Groq, LM Studio, vLLM, …)


pl`).
