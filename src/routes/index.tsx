import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Send,
  BookOpen,
  SlidersHorizontal,
  X,
  ArrowRight,
  Library,
  GraduationCap,
} from "lucide-react";
import { listCatalog } from "@/lib/syllabi.functions";

export const Route = createFileRoute("/")({
  component: ChatPage,
  head: () => ({
    meta: [
      { title: "Ask Sylabus AGH — chat o sylabusach" },
      {
        name: "description",
        content:
          "Zadaj pytanie o sylabusy AGH — wyszukiwanie semantyczne i odpowiedź ze źródłami.",
      },
    ],
  }),
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

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
};

type CatalogItem = {
  id: string;
  faculty: string;
  field: string;
  level: string | null;
  form: string | null;
  cycle: string | null;
  semester: string;
  course_name: string;
  source_url: string | null;
  chunk_count: number;
};

type Filters = {
  program_key: string | null;
  syllabus_id: string | null;
};

const EXAMPLES = [
  "Ile ECTS ma Algebra na 1 semestrze?",
  "Jakie są efekty kształcenia z Algorytmów i struktur danych?",
  "Co obejmuje przedmiot Wprowadzenie do elektroniki?",
  "Jaka jest forma zaliczenia z Teorii obwodów 1?",
];

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return uuid();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function newSessionId() {
  if (typeof window === "undefined") return "ssr";
  const k = "asksylabus.session";
  let s = localStorage.getItem(k);
  if (!s) {
    s = uuid();
    localStorage.setItem(k, s);
  }
  return s;
}

function cleanErrorMessage(raw: string): string {
  if (raw.trim().toLowerCase().startsWith("<!doctype html")) {
    return "Serwer zwrócił stronę błędu zamiast odpowiedzi czatu. Sprawdź logi kontenera aplikacji.";
  }
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const msg = parsed.error ?? parsed.message;
    if (typeof msg === "string" && msg.trim()) return msg;
  } catch {
    // raw text fallback below
  }
  return raw || "Nie udało się połączyć z czatem.";
}

function semesterRank(s: string): number {
  const m = s.match(/\d+/);
  return m ? parseInt(m[0], 10) : 999;
}

function programKey(
  i: Pick<CatalogItem, "field" | "level" | "form" | "cycle">,
): string {
  return [i.field, i.level ?? "", i.form ?? "", i.cycle ?? ""].join("|");
}

function programLabel(
  i: Pick<CatalogItem, "field" | "level" | "form" | "cycle">,
): string {
  return [i.field, i.level, i.form, i.cycle].filter(Boolean).join(" · ");
}

function ChatPage() {
  const [sessionId, setSessionId] = useState("ssr");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<Filters>({ program_key: null, syllabus_id: null });
  const [filterOpen, setFilterOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const fetchCatalog = useServerFn(listCatalog);
  const { data: catalog, isLoading: catalogLoading } = useQuery({
    queryKey: ["catalog"],
    queryFn: () => fetchCatalog(),
    staleTime: 60_000,
  });

  const items = (catalog?.items ?? []) as CatalogItem[];

  const programs = useMemo(() => {
    const map = new Map<string, CatalogItem>();
    for (const i of items) {
      const k = programKey(i);
      if (!map.has(k)) map.set(k, i);
    }
    return Array.from(map.entries())
      .map(([key, i]) => ({ key, label: programLabel(i), sample: i }))
      .sort((a, b) => {
        const cA = a.sample.cycle ?? "";
        const cB = b.sample.cycle ?? "";
        if (cA !== cB) return cB.localeCompare(cA);
        return a.label.localeCompare(b.label, "pl");
      });
  }, [items]);

  const selectedProgram = useMemo(
    () => programs.find((p) => p.key === filters.program_key) ?? null,
    [programs, filters.program_key],
  );

  const coursesInProgram = useMemo(() => {
    if (!filters.program_key) return [];
    return items
      .filter((i) => programKey(i) === filters.program_key)
      .sort(
        (a, b) =>
          semesterRank(a.semester) - semesterRank(b.semester) ||
          a.course_name.localeCompare(b.course_name),
      );
  }, [items, filters.program_key]);

  const selectedCourse = useMemo(
    () => items.find((i) => i.id === filters.syllabus_id) ?? null,
    [items, filters.syllabus_id],
  );

  // Auto-select the only program when there's exactly one (current state: just Elektronika).
  useEffect(() => {
    if (!filters.program_key && programs.length === 1) {
      setFilters((f) => ({ ...f, program_key: programs[0].key }));
    }
  }, [programs, filters.program_key]);

  useEffect(() => setSessionId(newSessionId()), []);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);
  useEffect(() => {
    if (!loading) inputRef.current?.focus();
  }, [loading, messages.length]);

  // Auto-fill from ?q= and apply ?program= / ?syllabus= filters (e.g. from catalog).
  // Run on first mount so the input + chip update IMMEDIATELY,
  // without waiting for the catalog server fn to resolve.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const q = url.searchParams.get("q");
    const program = url.searchParams.get("program");
    const syllabus = url.searchParams.get("syllabus");
    if (program || syllabus) {
      setFilters({ program_key: program, syllabus_id: syllabus });
    }
    if (q) setInput(q);
    if (q || program || syllabus) {
      url.searchParams.delete("q");
      url.searchParams.delete("program");
      url.searchParams.delete("syllabus");
      window.history.replaceState({}, "", url.pathname + url.hash);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isAllSelected = filters.program_key === "__all__";
  // Program is "pending" when URL set program_key but catalog hasn't loaded yet.
  const pendingProgram = !!filters.program_key && !isAllSelected && !selectedProgram && catalogLoading;

  async function send() {
    const q = input.trim();
    if (!q || loading) return;
    if (!selectedProgram && !filters.program_key) {
      setFilterOpen(true);
      return;
    }
    const field = isAllSelected
      ? null
      : (selectedProgram?.sample.field ??
         (filters.program_key ? filters.program_key.split("|")[0] : ""));
    setInput("");
    const userMsg: Msg = { id: uuid(), role: "user", content: q };
    const assistantId = uuid();
    setMessages((m) => [...m, userMsg, { id: assistantId, role: "assistant", content: "" }]);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          message: q,
          filters: {
            field,
            syllabus_id: filters.syllabus_id,
          },
        }),
      });
      if (!res.ok || !res.body) {
        const t = await res.text();
        throw new Error(cleanErrorMessage(t || `HTTP ${res.status}`));
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() || "";
        for (const evt of events) {
          const lines = evt.split("\n");
          const ev = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
          const data = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
          if (!ev || !data) continue;
          if (ev === "sources") {
            const sources = JSON.parse(data) as Source[];
            setMessages((m) =>
              m.map((x) => (x.id === assistantId ? { ...x, sources } : x)),
            );
          } else if (ev === "delta") {
            const delta = JSON.parse(data) as string;
            setMessages((m) =>
              m.map((x) =>
                x.id === assistantId ? { ...x, content: x.content + delta } : x,
              ),
            );
          } else if (ev === "error") {
            const msg = JSON.parse(data) as string;
            setMessages((m) =>
              m.map((x) =>
                x.id === assistantId
                  ? { ...x, content: `⚠️ Błąd: ${cleanErrorMessage(msg)}` }
                  : x,
              ),
            );
          }
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? cleanErrorMessage(e.message) : cleanErrorMessage(String(e));
      setMessages((m) =>
        m.map((x) =>
          x.id === assistantId ? { ...x, content: `⚠️ Błąd: ${msg}` } : x,
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  const filterLabel = pendingProgram
    ? "Wczytuję kierunek…"
    : isAllSelected
    ? "Wszystkie syllabusy"
    : selectedCourse
    ? selectedCourse.course_name
    : selectedProgram?.label ?? "— wybierz kierunek —";

  return (
    <div className="h-dvh overflow-hidden bg-[#fdfdfd] text-foreground flex flex-col relative selection:bg-primary/15">
      {/* Subtle background decoration */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden -z-10">
        <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] rounded-full blur-[120px] opacity-40 bg-primary/10" />
        <div className="absolute -bottom-[10%] -right-[10%] w-[40%] h-[40%] rounded-full blur-[120px] opacity-50 bg-slate-200/60" />
        <div
          className="absolute inset-0 opacity-[0.15]"
          style={{
            backgroundImage:
              "radial-gradient(#e5e7eb 1px, transparent 1px)",
            backgroundSize: "40px 40px",
          }}
        />
      </div>

      <header className="border-b border-slate-100 bg-white/70 backdrop-blur sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-white">
              <BookOpen className="h-4 w-4" />
            </div>
            <h1 className="text-base font-semibold tracking-tight">Ask Sylabus AGH</h1>
            <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">beta</Badge>
          </div>
          <nav className="ml-auto flex items-center gap-1 text-sm">
            <Link
              to="/catalog"
              className="px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-slate-100 transition"
            >
              Katalog
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1 min-h-0 max-w-3xl mx-auto w-full px-4 py-6 flex flex-col">
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto space-y-4 pb-4">
          {messages.length === 0 && (
            <div className="py-10">
              <div className="text-center mb-10">
                <div className="inline-flex h-20 w-20 items-center justify-center rounded-3xl bg-white border border-slate-100 shadow-xl shadow-slate-200/50 mb-6">
                  <GraduationCap className="h-9 w-9 text-primary" />
                </div>
                <h2 className="text-4xl font-extrabold tracking-tight text-slate-900">
                  Zapytaj o sylabusy AGH
                </h2>
                <p className="text-base text-slate-500 mt-3 max-w-md mx-auto">
                  Wybierz kierunek lub konkretny przedmiot, żeby zawęzić odpowiedź.
                </p>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => {
                      setInput(ex);
                      inputRef.current?.focus();
                    }}
                    className="group p-5 text-left bg-white border border-slate-200 rounded-2xl hover:border-primary hover:shadow-lg hover:shadow-primary/5 transition-all cursor-pointer"
                  >
                    <div className="flex justify-between items-start gap-3">
                      <p className="text-slate-700 font-medium leading-snug">{ex}</p>
                      <ArrowRight className="h-5 w-5 flex-shrink-0 opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all text-primary" />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <div
              key={m.id}
              className={
                m.role === "user" ? "flex justify-end" : "flex justify-start"
              }
            >
              {m.role === "user" ? (
                <div className="max-w-[85%] rounded-2xl bg-primary text-primary-foreground px-4 py-2 text-sm">
                  {m.content}
                </div>
              ) : (
                <div className="max-w-[90%] w-full text-sm">
                  <div className="text-foreground whitespace-pre-wrap leading-relaxed">
                    {m.content ||
                      (loading ? (
                        <span className="inline-flex items-center gap-2 text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Szukam w sylabusach…
                        </span>
                      ) : (
                        ""
                      ))}
                  </div>
                  {m.sources && m.sources.length > 0 && (
                    <details className="mt-3 group rounded-lg border bg-muted/30">
                      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground">
                        <Library className="h-3.5 w-3.5" />
                        Źródła ({m.sources.length})
                      </summary>
                      <div className="px-3 pb-3 space-y-1.5">
                        {m.sources.map((s, i) => (
                          <div key={i} className="text-xs">
                            <span className="text-muted-foreground">[{i + 1}]</span>{" "}
                            <span className="font-medium text-foreground">
                              {s.course_name}
                            </span>{" "}
                            <span className="text-muted-foreground">
                              — {s.field} / {s.semester}
                            </span>{" "}
                            {s.source_url && (
                              <a
                                href={s.source_url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-primary hover:underline"
                              >
                                link
                              </a>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="pt-3 border-t space-y-2">
          {/* Filter chip */}
          <div className="flex items-center gap-2 flex-wrap">
            <Popover open={filterOpen} onOpenChange={setFilterOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant={selectedProgram || pendingProgram || isAllSelected ? "default" : "outline"}
                  size="sm"
                  className={
                    "h-8 text-xs gap-1.5 " +
                    (!selectedProgram && !pendingProgram && !isAllSelected
                      ? "ring-2 ring-primary/40 animate-pulse"
                      : "")
                  }
                >
                  {pendingProgram ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                  )}
                  {pendingProgram ? (
                    <span>Wczytuję kierunek…</span>
                  ) : isAllSelected ? (
                    <span>Wszystkie syllabusy</span>
                  ) : selectedCourse ? (
                    <>
                      <span className="max-w-[200px] truncate">
                        {selectedCourse.course_name}
                      </span>
                      <span className="text-[10px] opacity-70">
                        · {selectedCourse.semester}
                      </span>
                    </>
                  ) : selectedProgram ? (
                    <span className="max-w-[280px] truncate">{selectedProgram.label}</span>
                  ) : (
                    "Wybierz kierunek studiów"
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[360px] p-3 space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    Kierunek studiów <span className="text-destructive">*</span>
                  </label>
                  <Select
                    value={filters.program_key ?? ""}
                    onValueChange={(v) =>
                      setFilters({
                        program_key: v || null,
                        syllabus_id: null,
                      })
                    }
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue placeholder="Wybierz kierunek…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">Wszystkie syllabusy</SelectItem>
                      {programs.length === 0 && (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                          Brak zaindeksowanych kierunków.
                        </div>
                      )}
                      {programs.map((p) => (
                        <SelectItem key={p.key} value={p.key}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {!isAllSelected && <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    Przedmiot (opcjonalnie)
                  </label>
                  <Select
                    value={filters.syllabus_id ?? "__any__"}
                    onValueChange={(v) =>
                      setFilters((prev) => ({
                        ...prev,
                        syllabus_id: v === "__any__" ? null : v,
                      }))
                    }
                    disabled={!filters.program_key}
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue
                        placeholder={
                          filters.program_key
                            ? "Cały kierunek"
                            : "Najpierw wybierz kierunek"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent className="max-h-[280px]">
                      <SelectItem value="__any__">Cały kierunek</SelectItem>
                      {coursesInProgram.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          <span className="text-muted-foreground mr-1">
                            {c.semester.replace(/^Semestr\s*/i, "S")}·
                          </span>
                          {c.course_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>}

                {(filters.program_key || filters.syllabus_id) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full h-8 text-xs"
                    onClick={() =>
                      setFilters({ program_key: null, syllabus_id: null })
                    }
                  >
                    <X className="h-3.5 w-3.5 mr-1" /> Wyczyść filtry
                  </Button>
                )}
              </PopoverContent>
            </Popover>

            <span className="text-xs text-muted-foreground truncate">
              Kontekst:{" "}
              <span
                className={
                  selectedProgram || pendingProgram || isAllSelected
                    ? "font-medium text-foreground"
                    : "text-destructive"
                }
              >
                {filterLabel}
              </span>
            </span>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            className="relative flex items-end gap-2 rounded-2xl border bg-card focus-within:ring-2 focus-within:ring-primary/30 transition p-2"
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Zadaj pytanie o sylabus… (Shift+Enter = nowa linia)"
              disabled={loading}
              rows={1}
              className="flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground max-h-40"
              style={{ minHeight: "2.25rem" }}
              autoFocus
            />
            <Button
              type="submit"
              size="icon"
              disabled={loading || !input.trim() || (!selectedProgram && !filters.program_key)}
              title={!selectedProgram && !filters.program_key ? "Wybierz najpierw kierunek studiów" : undefined}
              className="h-9 w-9 shrink-0 rounded-xl"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </form>
          <p className="text-[10px] text-muted-foreground text-center">
            Odpowiedzi opierają się wyłącznie na sylabusach AGH. Cytaty w nawiasach{" "}
            <code>[1]</code>, <code>[2]</code>.
          </p>
        </div>
      </main>
    </div>
  );
}
