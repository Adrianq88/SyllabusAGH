import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { listCatalog } from "@/lib/syllabi.functions";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { BookOpen, ChevronRight, ExternalLink, Loader2, Search } from "lucide-react";

export const Route = createFileRoute("/catalog")({
  component: CatalogPage,
  head: () => ({
    meta: [
      { title: "Katalog sylabusów AGH" },
      {
        name: "description",
        content:
          "Przeglądaj kierunki i przedmioty AGH pogrupowane wg semestrów.",
      },
    ],
  }),
});

type Item = {
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

function semesterRank(s: string): number {
  const m = s.match(/\d+/);
  return m ? parseInt(m[0], 10) : 999;
}

function programLabel(i: Pick<Item, "field" | "level" | "form" | "cycle">): string {
  return [i.field, i.level, i.form, i.cycle].filter(Boolean).join(" · ");
}

function programKey(i: Pick<Item, "field" | "level" | "form" | "cycle">): string {
  return [i.field, i.level ?? "", i.form ?? "", i.cycle ?? ""].join("|");
}

function CatalogPage() {
  const fetchCatalog = useServerFn(listCatalog);
  const { data, isLoading, error } = useQuery({
    queryKey: ["catalog"],
    queryFn: () => fetchCatalog(),
  });
  const [q, setQ] = useState("");

  const grouped = useMemo(() => {
    const items = (data?.items ?? []) as Item[];
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? items.filter(
          (i) =>
            i.course_name.toLowerCase().includes(needle) ||
            i.field.toLowerCase().includes(needle) ||
            i.faculty.toLowerCase().includes(needle) ||
            i.semester.toLowerCase().includes(needle) ||
            (i.level ?? "").toLowerCase().includes(needle) ||
            (i.form ?? "").toLowerCase().includes(needle) ||
            (i.cycle ?? "").toLowerCase().includes(needle),
        )
      : items;

    const facMap = new Map<string, Map<string, { label: string; semesters: Map<string, Item[]> }>>();
    for (const it of filtered) {
      const fac = it.faculty || "—";
      if (!facMap.has(fac)) facMap.set(fac, new Map());
      const progMap = facMap.get(fac)!;
      const key = programKey(it);
      if (!progMap.has(key))
        progMap.set(key, { label: programLabel(it), semesters: new Map() });
      const f = progMap.get(key)!;
      if (!f.semesters.has(it.semester)) f.semesters.set(it.semester, []);
      f.semesters.get(it.semester)!.push(it);
    }
    return Array.from(facMap.entries())
      .map(([faculty, progMap]) => {
        const programs = Array.from(progMap.entries())
          .map(([key, v]) => ({
            key,
            label: v.label,
            total: Array.from(v.semesters.values()).reduce((a, b) => a + b.length, 0),
            semesters: Array.from(v.semesters.entries())
              .map(([sem, courses]) => ({ sem, courses }))
              .sort((a, b) => semesterRank(a.sem) - semesterRank(b.sem)),
          }))
          .sort((a, b) => a.label.localeCompare(b.label, "pl"));
        return {
          faculty,
          total: programs.reduce((a, p) => a + p.total, 0),
          programs,
        };
      })
      .sort((a, b) => a.faculty.localeCompare(b.faculty, "pl"));
  }, [data, q]);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <Link to="/" className="flex items-center gap-2 font-semibold text-foreground">
            <BookOpen className="h-5 w-5 text-primary" />
            Ask Sylabus AGH
          </Link>
          <nav className="flex items-center gap-3 text-sm">
            <Link to="/" className="text-muted-foreground hover:text-foreground">
              Chat
            </Link>
            <Link to="/catalog" className="font-medium text-foreground">
              Katalog
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">Katalog sylabusów</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Przeglądaj kierunki i przedmioty pogrupowane wg semestrów.
          </p>
        </div>

        <div className="relative mb-6">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Szukaj kierunku lub przedmiotu…"
            className="pl-9"
          />
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Ładowanie…
          </div>
        )}
        {error && (
          <p className="text-sm text-destructive">Błąd: {(error as Error).message}</p>
        )}

        {!isLoading && grouped.length === 0 && (
          <Card className="p-6 text-sm text-muted-foreground">
            Brak wyników. Spróbuj innej frazy lub wróć później — katalog jest
            uzupełniany przez administratora.
          </Card>
        )}

        <div className="space-y-3">
          {grouped.map((fac) => (
            <details
              key={fac.faculty}
              className="group/fac rounded-lg border bg-card"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 bg-muted/30 rounded-t-lg">
                <div className="flex items-center gap-2">
                  <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-open/fac:rotate-90" />
                  <h2 className="text-lg font-semibold text-foreground">{fac.faculty}</h2>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">
                    {fac.programs.length}{" "}
                    {fac.programs.length === 1 ? "kierunek" : "kierunków"}
                  </Badge>
                  <Badge variant="secondary">{fac.total} przedm.</Badge>
                </div>
              </summary>

              <div className="space-y-2 border-t p-3">
                {fac.programs.map((g) => (
                  <details
                    key={g.key}
                    className="group rounded-md border bg-background"
                  >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3">
                      <div className="flex items-center gap-2">
                        <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-90" />
                        <span className="font-medium text-foreground">{g.label}</span>
                      </div>
                      <Badge variant="secondary">{g.total} przedm.</Badge>
                    </summary>

                    <div className="space-y-2 border-t px-3 py-2">
                      {g.semesters.map((s) => (
                        <details
                          key={s.sem}
                          className="group/sem rounded-md border bg-background"
                        >
                          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2">
                            <div className="flex items-center gap-2">
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open/sem:rotate-90" />
                              <span className="font-medium text-foreground">{s.sem}</span>
                            </div>
                            <Badge variant="outline">{s.courses.length}</Badge>
                          </summary>
                          <ul className="divide-y border-t">
                            {s.courses.map((c) => (
                              <li
                                key={c.id}
                                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                              >
                                <span className="text-foreground">{c.course_name}</span>
                                <div className="flex items-center gap-2">
                                  <Link
                                    to="/"
                                    search={{
                                      program: programKey(c),
                                      syllabus: c.id,
                                      q: `Powiedz mi o przedmiocie: ${c.course_name}`,
                                    }}
                                  >
                                    <Button size="sm" variant="ghost">
                                      Zapytaj
                                    </Button>
                                  </Link>
                                  {c.source_url && (
                                    <a
                                      href={c.source_url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                                    >
                                      źródło <ExternalLink className="h-3 w-3" />
                                    </a>
                                  )}
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
      </main>
    </div>
  );
}
