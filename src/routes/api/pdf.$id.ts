// Serwowanie PDFów z lokalnego storage. URL: /api/pdf/<syllabus-id>
import { createFileRoute } from "@tanstack/react-router";
import { queryOne } from "@/lib/db.server";
import { readPdf } from "@/lib/storage.server";

export const Route = createFileRoute("/api/pdf/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        // UUID v4 sanity check
        if (!/^[0-9a-f-]{36}$/i.test(params.id)) {
          return new Response("Bad id", { status: 400 });
        }
        const row = await queryOne<{ pdf_path: string | null }>(
          `SELECT pdf_path FROM syllabi WHERE id = $1`,
          [params.id],
        );
        if (!row?.pdf_path) return new Response("Not found", { status: 404 });
        const buf = await readPdf(row.pdf_path);
        if (!buf) return new Response("Not found", { status: 404 });
        // node Buffer is an ArrayBufferView; new Response accepts it
        return new Response(new Uint8Array(buf), {
          headers: {
            "content-type": "application/pdf",
            "cache-control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
