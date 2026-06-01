// Simple text chunker: ~400 token target (≈1600 chars) with 50-token overlap (≈200 chars).
// Splits on paragraph then sentence boundaries to keep semantic coherence.

const TARGET_CHARS = 1600;
const OVERLAP_CHARS = 200;

export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function chunkText(text: string): string[] {
  const clean = cleanText(text);
  if (clean.length <= TARGET_CHARS) return clean ? [clean] : [];

  // Split into paragraphs first
  const paras = clean.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = "";

  const flush = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = "";
  };

  for (const p of paras) {
    if (p.length > TARGET_CHARS) {
      // Split long paragraph by sentences
      const sents = p.split(/(?<=[.!?])\s+/);
      for (const s of sents) {
        if ((buf + " " + s).length > TARGET_CHARS) {
          flush();
          buf = s;
        } else {
          buf = buf ? buf + " " + s : s;
        }
      }
    } else if ((buf + "\n\n" + p).length > TARGET_CHARS) {
      flush();
      buf = p;
    } else {
      buf = buf ? buf + "\n\n" + p : p;
    }
  }
  flush();

  // Add overlap
  if (chunks.length <= 1) return chunks;
  const withOverlap: string[] = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const tail = prev.slice(Math.max(0, prev.length - OVERLAP_CHARS));
    withOverlap.push(tail + "\n\n" + chunks[i]);
  }
  return withOverlap;
}

export function approxTokens(text: string): number {
  // Rough heuristic: 1 token ≈ 4 chars
  return Math.ceil(text.length / 4);
}
