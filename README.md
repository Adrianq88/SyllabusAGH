# Ask Sylabus AGH

Lokalny chatbot RAG (Retrieval-Augmented Generation) odpowiadający na pytania o sylabusy AGH na podstawie oficjalnych kart przedmiotów z `sylabusy.agh.edu.pl`.

**Stack:** TanStack Start (React 19 + Node SSR), Postgres + pgvector, Ollama (lokalny LLM), HuggingFace TEI (embeddingi), Docker Compose.

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

Startuje 4 usługi: `postgres` (baza + pgvector), `ollama` (lokalny LLM), `tei` (embeddingi — pobiera model `sdadas/mmlw-retrieval-roberta-large-v2` automatycznie, ~1.3 GB), `app` (TanStack Start).

**4. Pobierz model czatu (jednorazowo, ~17 GB)**

```bash
docker compose exec ollama ollama pull gemma4:26b
```

Model embeddingów (`sdadas/mmlw-retrieval-roberta-large-v2`) pobierany jest automatycznie przez kontener `tei` przy pierwszym uruchomieniu.

**5. Otwórz aplikację**

http://localhost:8080

### Checklista weryfikacji

Po `docker compose up` sprawdź, że wszystko gra:

- [ ] `docker compose ps` — cztery usługi w stanie `running` / `healthy`
- [ ] http://localhost:8080 — ładuje się strona czatu
- [ ] http://localhost:8080/admin — ładuje się panel administracyjny
- [ ] `curl http://localhost:11434/api/tags` — Ollama odpowiada listą pobranych modeli (musi zawierać `gemma4:26b`)
- [ ] `curl http://localhost:8082/health` — TEI odpowiada `OK` (może chwilę trwać przy pierwszym uruchomieniu — pobiera model)
- [ ] `docker compose exec postgres psql -U sylabus -d sylabus -c "\dt"` — widać tabele `syllabi`, `syllabus_chunks`, `chat_messages`, `app_settings`
- [ ] W `/admin` → "Ustawienia LLM" pola są wypełnione (`http://ollama:11434/v1`, `gemma4:26b`, embed URL `http://tei:80/v1`, embed model `sdadas/mmlw-retrieval-roberta-large-v2`)

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

### Wymagania dotyczące okna kontekstu

Przy domyślnym `TOP_K = 15` prompt wysyłany do modelu czatu może mieć ~4000–5000 tokenów (fragmenty sylabusów + historia rozmowy + instrukcja systemowa). **Wymagane minimum to ~16k tokenów kontekstu** w modelu LLM.

Ollama domyślnie ustawia okno na 4096 tokenów — za mało. Docker Compose w tym repo ustawia `OLLAMA_CONTEXT_LENGTH: 32768` w serwisie `ollama`, co rozwiązuje problem.

Jeśli korzystasz z innego endpointu OpenAI-compatible (np. vLLM, LM Studio), upewnij się, że model jest załadowany z odpowiednim rozmiarem kontekstu (np. `--max-model-len 32768` w vLLM). Możesz też zmniejszyć `TOP_K` w panelu admina — przy `TOP_K ≤ 5` wystarczy ~16k tokenów kontekstu.
