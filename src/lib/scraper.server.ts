// Scraper dla sylabusy.agh.edu.pl.
//
// Strona kierunku (np. https://sylabusy.agh.edu.pl/pl/1/2/22/1/5/4/113) zawiera
// statyczny HTML z meta-danymi kierunku oraz panelami `nav-tab-{N}-panel` per
// semestr. W każdym panelu są przyciski z `data-syllabus-id="{uuid}"` i nazwą
// przedmiotu. Pełna karta przedmiotu jest pod:
//   https://sylabusy.agh.edu.pl/pl/document/{uuid}.html
//
// Dzięki temu nie potrzebujemy headless browsera — wystarczy fetch + regex.

const UA = "ask-sylabus-bot/0.1 (academic project)";

export type DiscoveredCourse = {
  uuid: string;
  course_name: string;
  semester: string; // np. "Semestr 1"
  document_url: string;
};

export type DiscoveredProgram = {
  field: string; // kierunek studiów, np. "Cyberbezpieczeństwo"
  faculty: string; // wydział
  level: string; // poziom kształcenia
  form: string; // forma studiów
  cycle: string; // np. "2026/2027"
  source_url: string;
  courses: DiscoveredCourse[];
};

export type DiscoveredFacultyProgram = {
  field: string;
  level: string;
  form: string;
  url: string;
};

export type DiscoveredFaculty = {
  faculty: string;
  cycle: string;
  source_url: string;
  programs: DiscoveredFacultyProgram[];
};

/**
 * Pobiera stronę wydziału (np. /pl/1/2/22/0/0/63) i zwraca listę kierunków
 * + ich poziomów/form, każdy z URL-em do strony kierunku.
 */
export async function discoverFaculty(facultyUrl: string): Promise<DiscoveredFaculty> {
  const html = await fetchText(facultyUrl);
  const titleMatch = html.match(/class="section-title"[^>]*>([\s\S]*?)<\/h1>/i);
  const faculty = titleMatch ? stripTags(titleMatch[1]) : "";
  const subMatch = html.match(/class="section-subtitle"[^>]*>([\s\S]*?)<\/div>/i);
  const cycle = subMatch ? stripTags(subMatch[1]) : "";

  // Split by headings: each <div class="student-view-content-list-heading">{field}</div>
  // followed by <ul>…<a href="…">{level, form}</a>…</ul>
  const programs: DiscoveredFacultyProgram[] = [];
  const blockRe =
    /class="student-view-content-list-heading"[^>]*>([\s\S]*?)<\/div>\s*<ul[\s\S]*?>([\s\S]*?)<\/ul>/gi;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(html))) {
    const field = stripTags(bm[1]);
    const ulHtml = bm[2];
    const aRe = /<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let am: RegExpExecArray | null;
    while ((am = aRe.exec(ulHtml))) {
      const rawUrl = am[1].trim();
      const url = new URL(rawUrl, facultyUrl).toString();
      const label = stripTags(am[2]);
      const parts = label.split(",").map((s) => s.trim()).filter(Boolean);
      const level = parts[0] || "";
      const form = parts[1] || "";
      programs.push({ field, level, form, url });
    }
  }

  return { faculty, cycle, source_url: facultyUrl, programs };
}

function decodeHtml(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripTags(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`Fetch ${url} failed: ${res.status}`);
  return res.text();
}

/**
 * Pobiera stronę kierunku AGH i zwraca metadane + listę przedmiotów per semestr.
 */
export async function discoverProgram(programUrl: string): Promise<DiscoveredProgram> {
  const html = await fetchText(programUrl);

  // Nazwa kierunku
  const fieldMatch = html.match(/id="syl-major-name"[^>]*>([\s\S]*?)<\/h1>/i);
  const field = fieldMatch ? stripTags(fieldMatch[1]).replace(/^Kierunek\s*/, "") : "";

  // Podtytuł: "2026/2027, Studia magisterskie inżynierskie II stopnia, Stacjonarne"
  const subMatch = html.match(/class="section-subtitle"[^>]*>([\s\S]*?)<\/div>/i);
  const subtitle = subMatch ? stripTags(subMatch[1]) : "";
  const subParts = subtitle.split(",").map((s) => s.trim());
  const cycle = subParts[0] || "";
  const level = subParts[1] || "";
  const form = subParts[2] || "";

  // Wydział z PDF programu — w HTML strony nie ma go bezpośrednio. Próbujemy
  // wyciągnąć z `<title>` lub z meta. Fallback: pusty.
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : "";
  const facultyMatch = title.match(/(Wydział[^|]+?)(?:\s*\||$)/i);
  const faculty = facultyMatch ? facultyMatch[1].trim() : "";

  // Mapa: id panelu (nav-tab-7) -> label semestru (Semestr 1)
  const semesterLabels = new Map<string, string>();
  const tabRe =
    /<button[^>]*id="(nav-tab-\d+)"[^>]*data-bs-target="#(nav-tab-\d+-panel)"[^>]*>([\s\S]*?)<\/button>/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tabRe.exec(html))) {
    const label = stripTags(tm[3]);
    if (/semestr/i.test(label)) semesterLabels.set(tm[2], label);
  }

  // Podziel HTML na panele (każdy panel zaczyna się od id="nav-tab-N-panel").
  const courses: DiscoveredCourse[] = [];
  const panelRe = /id="(nav-tab-\d+-panel)"[\s\S]*?(?=id="nav-tab-\d+-panel"|<\/main>|$)/gi;
  let pm: RegExpExecArray | null;
  while ((pm = panelRe.exec(html))) {
    const panelId = pm[1];
    const semester = semesterLabels.get(panelId);
    if (!semester) continue;
    const panelHtml = pm[0];

    const btnRe =
      /<button[^>]*data-syllabus-id="([a-f0-9-]{36})"[^>]*>([\s\S]*?)<\/button>/gi;
    let bm: RegExpExecArray | null;
    while ((bm = btnRe.exec(panelHtml))) {
      const uuid = bm[1];
      const name = stripTags(bm[2]);
      if (!name) continue;
      courses.push({
        uuid,
        course_name: name,
        semester,
        document_url: `https://sylabusy.agh.edu.pl/pl/document/${uuid}.html`,
      });
    }
  }

  return {
    field,
    faculty,
    level,
    form,
    cycle,
    source_url: programUrl,
    courses,
  };
}

/**
 * Pobiera kartę przedmiotu (HTML) i zwraca czysty tekst gotowy do chunkowania.
 */
export async function fetchCourseDocument(documentUrl: string): Promise<string> {
  const html = await fetchText(documentUrl);
  // Wytnij <main> jeśli jest, inaczej całe <body>.
  const main =
    html.match(/<main[\s\S]*?<\/main>/i)?.[0] ??
    html.match(/<body[\s\S]*?<\/body>/i)?.[0] ??
    html;
  // Konwertuj <br> i </p>/</div>/</tr>/</li> na nowe linie, żeby chunker miał z czym pracować.
  const withBreaks = main
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<\/td>/gi, " | ");
  return decodeHtml(
    withBreaks
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
