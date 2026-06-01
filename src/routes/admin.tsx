import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  listSyllabi,
  deleteSyllabus,
  reprocessSyllabus,
  discoverProgramPreview,
  ingestProgram,
  discoverFacultyPreview,
  ingestFaculty,
} from "@/lib/syllabi.functions";
import { getSettings, updateSettings } from "@/lib/settings.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, RefreshCw, Trash2, ChevronRight } from "lucide-react";

function semesterRank(label: string): number {
  const m = label.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 999;
}

type ProgramInfo = {
  field: string;
  level: string | null;
  form: string | null;
  cycle: string | null;
};

function programLabel(p: ProgramInfo): string {
  return [p.field, p.level, p.form, p.cycle].filter(Boolean).join(" · ");
}

function programKey(p: ProgramInfo): string {
  return [p.field, p.level ?? "—", p.form ?? "—", p.cycle ?? "—"].join("|");
}

function groupByFacultyProgramSemester<
  T extends ProgramInfo & { semester: string; faculty: string },
>(items: T[]) {
  const byFac = new Map<string, T[]>();
  for (const item of items) {
    const f = item.faculty || "—";
    if (!byFac.has(f)) byFac.set(f, []);
    byFac.get(f)!.push(item);
  }
  return Array.from(byFac.entries())
    .map(([faculty, list]) => {
      const byProg = new Map<string, { label: string; bySem: Map<string, T[]> }>();
      for (const item of list) {
        const key = programKey(item);
        if (!byProg.has(key))
          byProg.set(key, { label: programLabel(item), bySem: new Map() });
        const bySem = byProg.get(key)!.bySem;
        if (!bySem.has(item.semester)) bySem.set(item.semester, []);
        bySem.get(item.semester)!.push(item);
      }
      const programs = Array.from(byProg.entries())
        .map(([key, v]) => ({
          key,
          label: v.label,
          total: Array.from(v.bySem.values()).reduce((a, b) => a + b.length, 0),
          semesters: Array.from(v.bySem.entries())
            .map(([semester, items]) => ({ semester, items }))
            .sort((a, b) => semesterRank(a.semester) - semesterRank(b.semester)),
        }))
        .sort((a, b) => a.label.localeCompare(b.label, "pl"));
      return {
        faculty,
        total: programs.reduce((a, p) => a + p.total, 0),
        programs,
      };
    })
    .sort((a, b) => a.faculty.localeCompare(b.faculty, "pl"));
}

export const Route = createFileRoute("/admin")({
  component: AdminPage,
  head: () => ({
    meta: [{ title: "Admin · Ask Sylabus AGH" }, { name: "robots", content: "noindex" }],
  }),
});

function AdminPage() {
  const qc = useQueryClient();
  const list = useServerFn(listSyllabi);
  const del = useServerFn(deleteSyllabus);
  const re = useServerFn(reprocessSyllabus);
  const disc = useServerFn(discoverProgramPreview);
  const ingProg = useServerFn(ingestProgram);
  const discFac = useServerFn(discoverFacultyPreview);
  const ingFac = useServerFn(ingestFaculty);

  const { data, isLoading } = useQuery({
    queryKey: ["syllabi"],
    queryFn: () => list(),
    refetchInterval: 4000,
  });

  const [landing, setLanding] = useState(
    "https://sylabusy.agh.edu.pl/pl/1/2/22/1/5/4/113",
  );
  const [facultyOverride, setFacultyOverride] = useState("");
  const [program, setProgram] = useState<{
    field: string;
    faculty: string;
    courses: { uuid: string; course_name: string; semester: string; document_url: string }[];
  } | null>(null);
  const [importResults, setImportResults] = useState<
    { course_name: string; status: "ok" | "skipped" | "error"; error?: string }[]
  >([]);

  const [facultyUrl, setFacultyUrl] = useState(
    "https://sylabusy.agh.edu.pl/pl/1/2/22/0/0/63",
  );
  const [facultyPreview, setFacultyPreview] = useState<{
    name: string;
    cycle: string;
    programs: { field: string; level: string; form: string; url: string }[];
  } | null>(null);
  const [facultyImport, setFacultyImport] = useState<{
    name: string;
    programs: {
      field: string;
      level: string;
      form: string;
      ok: number;
      skipped: number;
      failed: number;
    }[];
  } | null>(null);

  const discoverMut = useMutation({
    mutationFn: async () => {
      const r = await disc({ data: { url: landing } });
      setProgram({
        field: r.program.field,
        faculty: r.program.faculty,
        courses: r.program.courses,
      });
      setImportResults([]);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const ingestProgMut = useMutation({
    mutationFn: async () => {
      const r = await ingProg({
        data: {
          url: landing,
          faculty_override: facultyOverride || null,
          skip_existing: true,
        } as never,
      });
      setImportResults(r.results);
      const ok = r.results.filter((x) => x.status === "ok").length;
      const skipped = r.results.filter((x) => x.status === "skipped").length;
      const failed = r.results.filter((x) => x.status === "error").length;
      toast.success(`Import zakończony: ${ok} nowych, ${skipped} pominiętych, ${failed} błędów`);
      qc.invalidateQueries({ queryKey: ["syllabi"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const discoverFacultyMut = useMutation({
    mutationFn: async () => {
      const r = await discFac({ data: { url: facultyUrl } });
      setFacultyPreview({
        name: r.faculty.faculty,
        cycle: r.faculty.cycle,
        programs: r.faculty.programs,
      });
      setFacultyImport(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const ingestFacultyMut = useMutation({
    mutationFn: async () => {
      const r = await ingFac({
        data: { url: facultyUrl, skip_existing: true } as never,
      });
      setFacultyImport({
        name: r.faculty.name ?? "",
        programs: r.programs.map((p) => ({
          field: p.field,
          level: p.level,
          form: p.form,
          ok: p.ok,
          skipped: p.skipped,
          failed: p.failed,
        })),
      });
      const ok = r.programs.reduce((a, p) => a + p.ok, 0);
      const skipped = r.programs.reduce((a, p) => a + p.skipped, 0);
      const failed = r.programs.reduce((a, p) => a + p.failed, 0);
      toast.success(
        `Wydział: ${r.programs.length} kierunków · ${ok} nowych, ${skipped} pominiętych, ${failed} błędów`,
      );
      qc.invalidateQueries({ queryKey: ["syllabi"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-lg font-semibold">Admin — Ask Sylabus AGH</h1>
          <nav className="flex gap-3 text-sm">
            <Link to="/" className="text-muted-foreground hover:text-foreground">chat</Link>
          </nav>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <LlmSettingsCard />

        <Card className="p-4 space-y-3">
          <h2 className="font-semibold">Importuj cały kierunek z sylabusy.agh.edu.pl</h2>
          <p className="text-xs text-muted-foreground">
            Wklej URL strony kierunku (np. <code>https://sylabusy.agh.edu.pl/pl/1/2/22/1/5/4/113</code>).
            Scraper wykryje wszystkie semestry i przedmioty, pobierze karty HTML każdego przedmiotu
            i zaindeksuje je. Już zaindeksowane (status <code>ready</code>) pomijamy.
          </p>
          <div className="grid md:grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>URL strony kierunku</Label>
              <Input value={landing} onChange={(e) => setLanding(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Wydział (override, opcjonalnie)</Label>
              <Input
                placeholder="np. Wydział Informatyki, Elektroniki i Telekomunikacji"
                value={facultyOverride}
                onChange={(e) => setFacultyOverride(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => discoverMut.mutate()}
              disabled={discoverMut.isPending || !landing}
            >
              {discoverMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Podgląd"}
            </Button>
            <Button
              onClick={() => ingestProgMut.mutate()}
              disabled={ingestProgMut.isPending || !landing}
            >
              {ingestProgMut.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Importuję…
                </>
              ) : (
                "Importuj wszystko"
              )}
            </Button>
          </div>

          {program && (
            <div className="text-xs space-y-2">
              <div className="text-muted-foreground">
                <span className="font-medium text-foreground">{program.field}</span>
                {program.faculty && <> · {program.faculty}</>} · {program.courses.length} przedmiotów
              </div>
              <div className="border rounded divide-y max-h-72 overflow-y-auto">
                {Array.from(
                  program.courses.reduce((m, c) => {
                    if (!m.has(c.semester)) m.set(c.semester, []);
                    m.get(c.semester)!.push(c);
                    return m;
                  }, new Map<string, typeof program.courses>()),
                )
                  .sort((a, b) => semesterRank(a[0]) - semesterRank(b[0]))
                  .map(([semester, items]) => (
                    <details key={semester} className="group" open>
                      <summary className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-muted/50 list-none">
                        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
                        <span className="font-medium">{semester}</span>
                        <span className="text-muted-foreground">({items.length})</span>
                      </summary>
                      <ul className="pl-7 pr-2 pb-2 space-y-1">
                        {items.map((c) => (
                          <li key={c.uuid} className="flex items-center justify-between gap-2">
                            <span className="truncate">{c.course_name}</span>
                            <a
                              href={c.document_url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary underline shrink-0"
                            >
                              otwórz
                            </a>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ))}
              </div>
            </div>
          )}

          {importResults.length > 0 && (
            <div className="text-xs space-y-1">
              <div className="flex gap-3 text-muted-foreground">
                <span><Badge variant="default">ok</Badge> {importResults.filter(r => r.status === "ok").length}</span>
                <span><Badge variant="secondary">skipped</Badge> {importResults.filter(r => r.status === "skipped").length}</span>
                <span><Badge variant="destructive">error</Badge> {importResults.filter(r => r.status === "error").length}</span>
              </div>
              <details className="border rounded">
                <summary className="px-2 py-1.5 cursor-pointer hover:bg-muted/50 select-none">
                  Pokaż szczegóły
                </summary>
                <div className="px-2 pb-2 space-y-1 max-h-56 overflow-y-auto">
                  {importResults.map((r, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Badge
                        variant={
                          r.status === "ok"
                            ? "default"
                            : r.status === "skipped"
                              ? "secondary"
                              : "destructive"
                        }
                      >
                        {r.status}
                      </Badge>
                      <span className="truncate">{r.course_name}</span>
                      {r.error && <span className="text-destructive truncate">{r.error}</span>}
                    </div>
                  ))}
                </div>
              </details>
            </div>
          )}
        </Card>

        <Card className="p-4 space-y-3">
          <h2 className="font-semibold">Importuj cały wydział</h2>
          <p className="text-xs text-muted-foreground">
            Wklej URL strony wydziału (np.{" "}
            <code>https://sylabusy.agh.edu.pl/pl/1/2/22/0/0/63</code>). Scraper
            wykryje wszystkie kierunki i ich poziomy/formy, po czym zaimportuje
            kolejno każdy z nich. Wydział z nagłówka strony zostanie użyty jako
            nazwa wydziału dla zaindeksowanych przedmiotów.
          </p>
          <div className="space-y-1">
            <Label>URL strony wydziału</Label>
            <Input
              value={facultyUrl}
              onChange={(e) => setFacultyUrl(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => discoverFacultyMut.mutate()}
              disabled={discoverFacultyMut.isPending || !facultyUrl}
            >
              {discoverFacultyMut.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Podgląd"
              )}
            </Button>
            <Button
              onClick={() => ingestFacultyMut.mutate()}
              disabled={ingestFacultyMut.isPending || !facultyUrl}
            >
              {ingestFacultyMut.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Importuję cały wydział…
                </>
              ) : (
                "Importuj cały wydział"
              )}
            </Button>
          </div>

          {facultyPreview && (
            <div className="text-xs space-y-2">
              <div className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  {facultyPreview.name || "—"}
                </span>
                {facultyPreview.cycle && <> · {facultyPreview.cycle}</>} ·{" "}
                {facultyPreview.programs.length} kierunków
              </div>
              <ul className="border rounded divide-y max-h-72 overflow-y-auto">
                {facultyPreview.programs.map((p, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 px-2 py-1.5">
                    <span className="truncate">
                      <span className="font-medium">{p.field}</span> ·{" "}
                      <span className="text-muted-foreground">
                        {[p.level, p.form].filter(Boolean).join(", ")}
                      </span>
                    </span>
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline shrink-0"
                    >
                      otwórz
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {facultyImport && (
            <div className="text-xs space-y-1">
              <div className="text-muted-foreground">
                Wynik dla{" "}
                <span className="font-medium text-foreground">
                  {facultyImport.name || "—"}
                </span>
                :
              </div>
              <ul className="border rounded divide-y max-h-72 overflow-y-auto">
                {facultyImport.programs.map((p, i) => (
                  <li key={i} className="flex items-center gap-2 px-2 py-1.5">
                    <span className="flex-1 truncate">
                      <span className="font-medium">{p.field}</span>{" "}
                      <span className="text-muted-foreground">
                        · {[p.level, p.form].filter(Boolean).join(", ")}
                      </span>
                    </span>
                    <Badge variant="default">{p.ok} ok</Badge>
                    <Badge variant="secondary">{p.skipped} skip</Badge>
                    {p.failed > 0 && (
                      <Badge variant="destructive">{p.failed} err</Badge>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Sylabusy w bazie</h2>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{data?.syllabi?.length ?? 0} przedmiotów</span>
              {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            </div>
          </div>

          {(data?.syllabi ?? []).length === 0 && !isLoading && (
            <div className="py-6 text-center text-muted-foreground text-sm">
              Brak sylabusów. Dodaj pierwszy powyżej lub zaimportuj cały kierunek.
            </div>
          )}

          <div className="space-y-2">
            {groupByFacultyProgramSemester(data?.syllabi ?? []).map((fac) => (
              <details
                key={fac.faculty}
                className="group/fac border rounded-lg overflow-hidden bg-card"
              >
                <summary className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-muted/40 list-none bg-muted/30">
                  <ChevronRight className="h-4 w-4 transition-transform group-open/fac:rotate-90 text-muted-foreground" />
                  <span className="font-semibold">{fac.faculty}</span>
                  <Badge variant="secondary" className="ml-1">{fac.total}</Badge>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {fac.programs.length}{" "}
                    {fac.programs.length === 1 ? "kierunek" : "kierunków"}
                  </span>
                </summary>
                <div className="border-t p-2 space-y-2">
                  {fac.programs.map((g) => (
                    <details
                      key={g.key}
                      className="group border rounded-lg overflow-hidden bg-card"
                    >
                      <summary className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-muted/40 list-none">
                        <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90 text-muted-foreground" />
                        <span className="font-medium">{g.label}</span>
                        <Badge variant="secondary" className="ml-1">{g.total}</Badge>
                        <span className="text-xs text-muted-foreground ml-auto">
                          {g.semesters.length}{" "}
                          {g.semesters.length === 1 ? "semestr" : "semestry"}
                        </span>
                      </summary>

                      <div className="divide-y border-t">
                        {g.semesters.map((sem) => (
                          <details key={sem.semester} className="group/sem">
                            <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/30 list-none bg-muted/10">
                              <ChevronRight className="h-3 w-3 transition-transform group-open/sem:rotate-90 text-muted-foreground" />
                              <span className="text-sm font-medium">{sem.semester}</span>
                              <span className="text-xs text-muted-foreground">({sem.items.length})</span>
                            </summary>
                            <ul className="divide-y">
                              {sem.items.map((s) => (
                                <li
                                  key={s.id}
                                  className="flex items-center gap-3 px-3 py-2 pl-9 hover:bg-muted/20"
                                >
                                  <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium truncate">{s.course_name}</div>
                                    {s.error && (
                                      <div className="text-xs text-destructive truncate">{s.error}</div>
                                    )}
                                  </div>
                                  <Badge
                                    variant={
                                      s.status === "ready"
                                        ? "default"
                                        : s.status === "failed"
                                          ? "destructive"
                                          : "secondary"
                                    }
                                    className="shrink-0"
                                  >
                                    {s.status}
                                  </Badge>
                                  <span className="text-xs text-muted-foreground w-12 text-right shrink-0">
                                    {s.chunk_count}
                                  </span>
                                  <div className="flex gap-0.5 shrink-0">
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      title="Przeprocesuj"
                                      onClick={async () => {
                                        try {
                                          await re({ data: { id: s.id } });
                                          toast.success("Przeprocesowano");
                                          qc.invalidateQueries({ queryKey: ["syllabi"] });
                                        } catch (e) {
                                          toast.error(e instanceof Error ? e.message : String(e));
                                        }
                                      }}
                                    >
                                      <RefreshCw className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      title="Usuń"
                                      onClick={async () => {
                                        if (!confirm(`Usunąć "${s.course_name}"?`)) return;
                                        try {
                                          await del({ data: { id: s.id } });
                                          toast.success("Usunięto");
                                          qc.invalidateQueries({ queryKey: ["syllabi"] });
                                        } catch (e) {
                                          toast.error(e instanceof Error ? e.message : String(e));
                                        }
                                      }}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </details>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </Card>
      </main>
    </div>
  );
}

const CHAT_MODEL_PRESETS = [
  { group: "Ollama (lokalnie)", items: ["gemma2:2b", "gemma2:9b", "llama3.2:3b", "llama3.1:8b", "qwen2.5:3b", "mistral:7b"] },
  { group: "OpenAI", items: ["gpt-5-nano", "gpt-5-mini", "gpt-5", "gpt-4o-mini"] },
  { group: "Groq", items: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] },
];

const EMBED_MODEL_PRESETS = [
  { group: "Ollama (768 dim)", items: ["nomic-embed-text", "mxbai-embed-large"] },
  { group: "OpenAI", items: ["text-embedding-3-small", "text-embedding-3-large"] },
];

const BASE_URL_PRESETS = [
  { label: "Ollama (lokalnie)", url: "http://localhost:11434/v1" },
  { label: "OpenAI", url: "https://api.openai.com/v1" },
  { label: "Groq", url: "https://api.groq.com/openai/v1" },
];

function LlmSettingsCard() {
  const get = useServerFn(getSettings);
  const upd = useServerFn(updateSettings);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["llm-settings"],
    queryFn: () => get(),
  });

  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [chatModel, setChatModel] = useState("");
  const [embedModel, setEmbedModel] = useState("");
  const [topK, setTopK] = useState(15);
  const [hydrated, setHydrated] = useState(false);

  if (data && !hydrated) {
    setBaseURL(data.llm_base_url);
    setChatModel(data.chat_model);
    setEmbedModel(data.embed_model);
    setTopK(data.top_k);
    setHydrated(true);
  }

  const save = useMutation({
    mutationFn: async () => {
      await upd({
        data: {
          llm_base_url: baseURL.trim() || null,
          // pusty klucz = nie zmieniaj (wstaw placeholder żeby walidacja przeszła)
          llm_api_key: apiKey.trim() || (data?.llm_api_key_masked ? "__keep__" : null),
          chat_model: chatModel.trim() || null,
          embed_model: embedModel.trim() || null,
          top_k: Math.max(1, Math.min(50, Math.round(topK) || 15)),
        },
      });
    },
    onSuccess: () => {
      toast.success("Zapisano ustawienia. Nowa konfiguracja wejdzie w życie w ciągu 5s.");
      setApiKey("");
      qc.invalidateQueries({ queryKey: ["llm-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Ustawienia modeli LLM</h2>
        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>
      <p className="text-xs text-muted-foreground">
        Konfiguracja zapisywana w bazie (nadpisuje zmienne środowiskowe). Działa od ręki — nie wymaga restartu.
        Dla lokalnej Ollamy zostaw <code>http://localhost:11434/v1</code> i klucz <code>ollama</code>.
      </p>

      <div className="grid md:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Base URL (OpenAI-compatible)</Label>
          <Input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="http://localhost:11434/v1" />
          <div className="flex flex-wrap gap-1 pt-1">
            {BASE_URL_PRESETS.map((p) => (
              <button
                key={p.url}
                type="button"
                onClick={() => setBaseURL(p.url)}
                className="text-[10px] px-2 py-0.5 rounded border hover:bg-muted"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <Label>API Key</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={data?.llm_api_key_masked ? `aktualnie: ${data.llm_api_key_masked} (zostaw puste = bez zmian)` : "ollama / sk-... / gsk_..."}
          />
        </div>

        <div className="space-y-1">
          <Label>Model czatu</Label>
          <Input value={chatModel} onChange={(e) => setChatModel(e.target.value)} placeholder="gemma2:2b" list="chat-models" />
          <datalist id="chat-models">
            {CHAT_MODEL_PRESETS.flatMap((g) => g.items).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <div className="flex flex-wrap gap-1 pt-1">
            {CHAT_MODEL_PRESETS.map((g) => (
              <details key={g.group} className="text-[10px]">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground px-1">
                  {g.group}
                </summary>
                <div className="flex flex-wrap gap-1 pt-1">
                  {g.items.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setChatModel(m)}
                      className="px-2 py-0.5 rounded border hover:bg-muted"
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <Label>Model embeddingów (musi zwracać 768 wymiarów)</Label>
          <Input value={embedModel} onChange={(e) => setEmbedModel(e.target.value)} placeholder="nomic-embed-text" list="embed-models" />
          <datalist id="embed-models">
            {EMBED_MODEL_PRESETS.flatMap((g) => g.items).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <div className="flex flex-wrap gap-1 pt-1">
            {EMBED_MODEL_PRESETS.map((g) => (
              <details key={g.group} className="text-[10px]">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground px-1">
                  {g.group}
                </summary>
                <div className="flex flex-wrap gap-1 pt-1">
                  {g.items.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setEmbedModel(m)}
                      className="px-2 py-0.5 rounded border hover:bg-muted"
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-1 max-w-xs">
        <Label>Top-K (liczba pobieranych fragmentów)</Label>
        <Input
          type="number"
          min={1}
          max={50}
          value={topK}
          onChange={(e) => setTopK(Number(e.target.value))}
        />
        <p className="text-[11px] text-muted-foreground">
          Ile najbardziej podobnych fragmentów sylabusów trafia do kontekstu LLM (1–50). Domyślnie 15.
          Więcej = lepsza odpowiedź na pytania „edge case", ale wolniej i drożej.
        </p>
      </div>


      <div className="flex items-center gap-3">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Zapisz konfigurację"}
        </Button>
        <p className="text-[11px] text-muted-foreground">
          Po zmianie modelu embeddingów <strong>wszystkie sylabusy trzeba przeindeksować</strong> (przycisk „reprocess" niżej).
        </p>
      </div>
    </Card>
  );
}
