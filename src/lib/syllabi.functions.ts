import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { query, queryOne, toVectorLiteral } from "./db.server";
import { savePdf, deletePdf, readPdf } from "./storage.server";
import { pdfToText } from "./pdf.server";
import { chunkText, approxTokens } from "./chunking.server";
import { embed } from "./openai.server";
import { discoverProgram, discoverFaculty, fetchCourseDocument } from "./scraper.server";

const META = z.object({
  faculty: z.string().min(1).max(255),
  field: z.string().min(1).max(255),
  semester: z.string().min(1).max(64),
  course_name: z.string().min(1).max(500),
  source_url: z.string().url().optional().nullable(),
});

async function setStatus(
  syllabusId: string,
  patch: { status: string; error?: string | null; chunk_count?: number },
) {
  const fields: string[] = ["status = $2"];
  const params: unknown[] = [syllabusId, patch.status];
  if ("error" in patch) {
    params.push(patch.error ?? null);
    fields.push(`error = $${params.length}`);
  }
  if (typeof patch.chunk_count === "number") {
    params.push(patch.chunk_count);
    fields.push(`chunk_count = $${params.length}`);
  }
  await query(
    `UPDATE syllabi SET ${fields.join(", ")} WHERE id = $1`,
    params,
  );
}

async function indexText(syllabusId: string, raw: string) {
  const chunks = chunkText(raw);
  if (chunks.length === 0) throw new Error("No text extracted");

  const BATCH = 64;
  await query(`DELETE FROM syllabus_chunks WHERE syllabus_id = $1`, [syllabusId]);

  let total = 0;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH);
    const vectors = await embed(slice);
    // Multi-row insert
    const values: string[] = [];
    const params: unknown[] = [];
    slice.forEach((content, j) => {
      const base = params.length;
      params.push(
        syllabusId,
        i + j,
        content,
        approxTokens(content),
        toVectorLiteral(vectors[j]),
      );
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::vector)`,
      );
    });
    await query(
      `INSERT INTO syllabus_chunks (syllabus_id, chunk_index, content, token_count, embedding)
       VALUES ${values.join(", ")}`,
      params,
    );
    total += slice.length;
  }

  await setStatus(syllabusId, { status: "ready", chunk_count: total, error: null });
}

async function processBuffer(syllabusId: string, buffer: ArrayBuffer) {
  await setStatus(syllabusId, { status: "processing", error: null });
  try {
    const raw = await pdfToText(buffer);
    await indexText(syllabusId, raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await setStatus(syllabusId, { status: "failed", error: msg });
    throw e;
  }
}

async function processHtmlDoc(syllabusId: string, documentUrl: string) {
  await setStatus(syllabusId, { status: "processing", error: null });
  try {
    const raw = await fetchCourseDocument(documentUrl);
    await indexText(syllabusId, raw);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await setStatus(syllabusId, { status: "failed", error: msg });
    throw e;
  }
}

export const listCatalog = createServerFn({ method: "GET" }).handler(async () => {
  const items = await query<{
    id: string;
    faculty: string;
    field: string;
    level: string | null;
    form: string | null;
    cycle: string | null;
    semester: string;
    course_name: string;
    source_url: string | null;
    status: string;
    chunk_count: number;
  }>(
    `SELECT id, faculty, field, level, form, cycle, semester, course_name,
            source_url, status, chunk_count
       FROM syllabi
      WHERE status = 'ready'
      ORDER BY field ASC, level ASC NULLS LAST, form ASC NULLS LAST,
               cycle DESC NULLS LAST, semester ASC, course_name ASC`,
  );
  return { items };
});

export const listSyllabi = createServerFn({ method: "GET" }).handler(async () => {
  const syllabi = await query<{
    id: string;
    faculty: string;
    field: string;
    level: string | null;
    form: string | null;
    cycle: string | null;
    semester: string;
    course_name: string;
    source_url: string | null;
    pdf_path: string | null;
    status: string;
    chunk_count: number;
    error: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT * FROM syllabi ORDER BY created_at DESC`,
  );
  return { syllabi };
});

export const deleteSyllabus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const row = await queryOne<{ pdf_path: string | null }>(
      `SELECT pdf_path FROM syllabi WHERE id = $1`,
      [data.id],
    );
    if (row?.pdf_path) await deletePdf(row.pdf_path);
    // ON DELETE CASCADE usuwa chunki automatycznie
    await query(`DELETE FROM syllabi WHERE id = $1`, [data.id]);
    return { ok: true };
  });

async function insertSyllabus(meta: {
  faculty: string;
  field: string;
  level?: string | null;
  form?: string | null;
  cycle?: string | null;
  semester: string;
  course_name: string;
  source_url?: string | null;
}): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO syllabi (faculty, field, level, form, cycle, semester, course_name, source_url, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
     RETURNING id`,
    [
      meta.faculty,
      meta.field,
      meta.level ?? null,
      meta.form ?? null,
      meta.cycle ?? null,
      meta.semester,
      meta.course_name,
      meta.source_url ?? null,
    ],
  );
  if (!row) throw new Error("Insert failed");
  return row.id;
}

export const ingestFromUrl = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    META.extend({ pdf_url: z.string().url() }).parse(d),
  )
  .handler(async ({ data }) => {
    const id = await insertSyllabus({
      faculty: data.faculty,
      field: data.field,
      semester: data.semester,
      course_name: data.course_name,
      source_url: data.source_url ?? data.pdf_url,
    });

    const res = await fetch(data.pdf_url);
    if (!res.ok) {
      await setStatus(id, { status: "failed", error: `Fetch failed: ${res.status}` });
      throw new Error(`Fetch failed: ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    const pdfPath = await savePdf(id, buf);
    await query(`UPDATE syllabi SET pdf_path = $1 WHERE id = $2`, [pdfPath, id]);

    await processBuffer(id, buf);
    return { id };
  });

export const ingestFromBase64 = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    META.extend({ filename: z.string().min(1).max(255), base64: z.string().min(10) }).parse(d),
  )
  .handler(async ({ data }) => {
    const id = await insertSyllabus({
      faculty: data.faculty,
      field: data.field,
      semester: data.semester,
      course_name: data.course_name,
      source_url: data.source_url ?? null,
    });
    const bin = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
    const pdfPath = await savePdf(id, bin);
    await query(`UPDATE syllabi SET pdf_path = $1 WHERE id = $2`, [pdfPath, id]);

    await processBuffer(id, bin.buffer);
    return { id };
  });

export const reprocessSyllabus = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const row = await queryOne<{ pdf_path: string | null; source_url: string | null }>(
      `SELECT pdf_path, source_url FROM syllabi WHERE id = $1`,
      [data.id],
    );
    if (!row) throw new Error("Not found");
    if (row.pdf_path) {
      const buf = await readPdf(row.pdf_path);
      if (!buf) throw new Error("PDF file missing on disk");
      const ab = new ArrayBuffer(buf.byteLength);
      new Uint8Array(ab).set(buf);
      await processBuffer(data.id, ab);
    } else if (row.source_url) {
      await processHtmlDoc(data.id, row.source_url);
    } else {
      throw new Error("No PDF or source URL on file");
    }
    return { ok: true };
  });

export const discoverProgramPreview = createServerFn({ method: "POST" })
  .inputValidator((d: { url: string }) =>
    z.object({ url: z.string().url() }).parse(d),
  )
  .handler(async ({ data }) => {
    const program = await discoverProgram(data.url);
    return { program };
  });

/**
 * Uzupełnia metadane programu (cycle / level / form / field / faculty) dla
 * już zaindeksowanych sylabusów — bez ponownego ściągania i indeksowania.
 */
export const backfillProgramMetadata = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        url: z.string().url(),
        faculty_override: z.string().max(255).optional().nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const program = await discoverProgram(data.url);
    const faculty =
      data.faculty_override ||
      program.faculty ||
      "Wydział Informatyki, Elektroniki i Telekomunikacji";

    const urls = program.courses.map((c) => c.document_url);
    if (urls.length === 0) return { updated: 0, program };

    const updated = await query<{ id: string }>(
      `UPDATE syllabi
          SET cycle = $1, level = $2, form = $3, field = $4, faculty = $5
        WHERE source_url = ANY($6::text[])
        RETURNING id`,
      [
        program.cycle || null,
        program.level || null,
        program.form || null,
        program.field,
        faculty,
        urls,
      ],
    );
    return {
      updated: updated.length,
      program: {
        field: program.field,
        faculty,
        level: program.level,
        form: program.form,
        cycle: program.cycle,
        courses: program.courses.length,
      },
    };
  });

type CourseImportResult = {
  uuid: string;
  course_name: string;
  status: "ok" | "skipped" | "error";
  error?: string;
};

async function ingestProgramByUrl(
  url: string,
  facultyOverride: string | null,
  skipExisting: boolean,
): Promise<{
  program: {
    field: string;
    faculty: string;
    level: string | null;
    form: string | null;
    cycle: string | null;
    courses: number;
  };
  results: CourseImportResult[];
}> {
  const program = await discoverProgram(url);
  const faculty =
    facultyOverride ||
    program.faculty ||
    "Wydział Informatyki, Elektroniki i Telekomunikacji";
  const fieldName = program.field || "—";
  const results: CourseImportResult[] = [];

  for (const c of program.courses) {
    try {
      if (skipExisting) {
        const existing = await queryOne<{ id: string; status: string }>(
          `SELECT id, status FROM syllabi
            WHERE source_url = $1
              AND field = $2
              AND ((level IS NULL AND $3::text IS NULL) OR level = $3)
              AND ((form  IS NULL AND $4::text IS NULL) OR form  = $4)
              AND ((cycle IS NULL AND $5::text IS NULL) OR cycle = $5)
            LIMIT 1`,
          [
            c.document_url,
            fieldName,
            program.level || null,
            program.form || null,
            program.cycle || null,
          ],
        );
        if (existing?.status === "ready") {
          results.push({ uuid: c.uuid, course_name: c.course_name, status: "skipped" });
          continue;
        }
      }

      const id = await insertSyllabus({
        faculty,
        field: fieldName,
        level: program.level || null,
        form: program.form || null,
        cycle: program.cycle || null,
        semester: c.semester,
        course_name: c.course_name,
        source_url: c.document_url,
      });
      await processHtmlDoc(id, c.document_url);
      results.push({ uuid: c.uuid, course_name: c.course_name, status: "ok" });
    } catch (e) {
      results.push({
        uuid: c.uuid,
        course_name: c.course_name,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    program: {
      field: program.field,
      faculty,
      level: program.level,
      form: program.form,
      cycle: program.cycle,
      courses: program.courses.length,
    },
    results,
  };
}

export const ingestProgram = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        url: z.string().url(),
        faculty_override: z.string().max(255).optional().nullable(),
        skip_existing: z.boolean().optional().default(true),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    return ingestProgramByUrl(
      data.url,
      data.faculty_override ?? null,
      data.skip_existing !== false,
    );
  });

export const discoverFacultyPreview = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ url: z.string().url() }).parse(d),
  )
  .handler(async ({ data }) => {
    const faculty = await discoverFaculty(data.url);
    return { faculty };
  });

export const ingestFaculty = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        url: z.string().url(),
        skip_existing: z.boolean().optional().default(true),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const fac = await discoverFaculty(data.url);
    const facultyName = fac.faculty || null;
    const programs: {
      url: string;
      field: string;
      level: string;
      form: string;
      courses: number;
      ok: number;
      skipped: number;
      failed: number;
      results: CourseImportResult[];
    }[] = [];

    for (const p of fac.programs) {
      try {
        const r = await ingestProgramByUrl(
          p.url,
          facultyName,
          data.skip_existing !== false,
        );
        programs.push({
          url: p.url,
          field: p.field,
          level: p.level,
          form: p.form,
          courses: r.program.courses,
          ok: r.results.filter((x) => x.status === "ok").length,
          skipped: r.results.filter((x) => x.status === "skipped").length,
          failed: r.results.filter((x) => x.status === "error").length,
          results: r.results,
        });
      } catch (e) {
        programs.push({
          url: p.url,
          field: p.field,
          level: p.level,
          form: p.form,
          courses: 0,
          ok: 0,
          skipped: 0,
          failed: 1,
          results: [
            {
              uuid: "",
              course_name: `${p.field} · ${p.level} · ${p.form}`,
              status: "error",
              error: e instanceof Error ? e.message : String(e),
            },
          ],
        });
      }
    }

    return {
      faculty: { name: fac.faculty, cycle: fac.cycle, source_url: fac.source_url },
      programs,
    };
  });
