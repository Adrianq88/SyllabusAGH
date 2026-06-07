-- Schemat bazy danych Ask Sylabus AGH (self-hosted).
-- Wykonywany automatycznie przy pierwszym starcie kontenera pgvector
-- (mount jako /docker-entrypoint-initdb.d/init.sql w docker-compose.yml).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =====================================================================
-- syllabi: nagłówki sylabusów (metadata kierunku + przedmiotu)
-- =====================================================================
CREATE TABLE IF NOT EXISTS syllabi (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  faculty      text NOT NULL,
  field        text NOT NULL,
  level        text,
  form         text,
  cycle        text,
  semester     text NOT NULL,
  course_name  text NOT NULL,
  source_url   text,
  pdf_path     text,
  status       text NOT NULL DEFAULT 'pending',
  chunk_count  integer NOT NULL DEFAULT 0,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS syllabi_status_idx ON syllabi(status);
CREATE INDEX IF NOT EXISTS syllabi_source_url_idx ON syllabi(source_url);

-- =====================================================================
-- syllabus_chunks: fragmenty tekstu z embeddingami (vector(768))
-- 768 = nomic-embed-text (Ollama) / text-embedding-3-* z dimensions=768
-- =====================================================================
CREATE TABLE IF NOT EXISTS syllabus_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  syllabus_id  uuid NOT NULL REFERENCES syllabi(id) ON DELETE CASCADE,
  chunk_index  integer NOT NULL,
  content      text NOT NULL,
  token_count  integer NOT NULL DEFAULT 0,
  embedding    vector(768),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS syllabus_chunks_syllabus_id_idx ON syllabus_chunks(syllabus_id);
CREATE INDEX IF NOT EXISTS syllabus_chunks_embedding_idx
  ON syllabus_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- =====================================================================
-- chat_messages: historia rozmów (opcjonalna, do debugu / późniejszego eval)
-- =====================================================================
CREATE TABLE IF NOT EXISTS chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  text NOT NULL,
  role        text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     text NOT NULL,
  sources     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_session_idx ON chat_messages(session_id, created_at);

-- =====================================================================
-- app_settings: pojedynczy wiersz (id=1) z konfiguracją LLM zarządzaną z /admin
-- =====================================================================
CREATE TABLE IF NOT EXISTS app_settings (
  id              integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  llm_base_url    text,
  llm_api_key     text,
  chat_model      text,
  embed_model     text,
  embed_base_url  text,
  embed_api_key   text,
  top_k           integer NOT NULL DEFAULT 15,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- =====================================================================
-- Funkcja wyszukiwania semantycznego — zwraca top-N chunków posortowanych
-- po cosine similarity, opcjonalnie filtrując po wydziale/kierunku/semestrze.
-- =====================================================================
CREATE OR REPLACE FUNCTION match_syllabus_chunks(
  query_embedding   vector(768),
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
  SELECT
    c.id,
    c.syllabus_id,
    c.chunk_index,
    c.content,
    (1 - (c.embedding <=> query_embedding))::real AS similarity,
    s.faculty,
    s.field,
    s.semester,
    s.course_name,
    s.source_url
  FROM syllabus_chunks c
  JOIN syllabi s ON s.id = c.syllabus_id
  WHERE s.status = 'ready'
    AND (filter_faculty  IS NULL OR s.faculty  = filter_faculty)
    AND (filter_field    IS NULL OR s.field    = filter_field)
    AND (filter_semester IS NULL OR s.semester = filter_semester)
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Trigger aktualizujący updated_at na syllabi.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS syllabi_set_updated_at ON syllabi;
CREATE TRIGGER syllabi_set_updated_at BEFORE UPDATE ON syllabi
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS app_settings_set_updated_at ON app_settings;
CREATE TRIGGER app_settings_set_updated_at BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
