// Lokalny storage PDFów na filesystem.
// Ścieżka z env PDF_STORAGE_DIR (domyślnie /data/pdfs — wolumen w docker-compose).
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

function dir(): string {
  return process.env.PDF_STORAGE_DIR || "/data/pdfs";
}

async function ensureDir(): Promise<string> {
  const d = dir();
  await mkdir(d, { recursive: true });
  return d;
}

export async function savePdf(id: string, data: ArrayBuffer | Uint8Array): Promise<string> {
  const d = await ensureDir();
  const rel = `${id}.pdf`;
  const abs = join(d, rel);
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  await writeFile(abs, buf);
  return rel;
}

export async function readPdf(relPath: string): Promise<Buffer | null> {
  try {
    return await readFile(join(dir(), relPath));
  } catch {
    return null;
  }
}

export async function deletePdf(relPath: string): Promise<void> {
  try {
    await unlink(join(dir(), relPath));
  } catch {
    // ignore — plik mógł już nie istnieć
  }
}
