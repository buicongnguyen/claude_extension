/** Bounded UTF-8 JSONL decoding. Oversized records are skipped through their newline. */
import { StringDecoder } from "node:string_decoder";
export const MAX_JSONL_LINE_BYTES = 1024 * 1024;
export interface DecodedLine { line: string; byteLength: number }
export interface LineDecoder {
  push(buf: Buffer, bytesRead: number): string[];
  pushWithOffsets(buf: Buffer, bytesRead: number): DecodedLine[];
  end(): string;
  readonly skippedLines: number;
}
export function createLineDecoder(maxBytes = MAX_JSONL_LINE_BYTES): LineDecoder {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid line limit");
  let decoder = new StringDecoder("utf8");
  let parts: string[] = [];
  let lineBytes = 0;
  let dropping = false;
  let skippedLines = 0;
  const reset = () => { decoder = new StringDecoder("utf8"); parts = []; lineBytes = 0; dropping = false; };
  const pushWithOffsets = (buf: Buffer, bytesRead: number): DecodedLine[] => {
    const out: DecodedLine[] = [];
    const size = Math.min(buf.length, Math.max(0, bytesRead));
    let start = 0;
    while (start < size) {
      const newline = buf.indexOf(10, start);
      const complete = newline >= 0 && newline < size;
      const end = complete ? newline : size;
      lineBytes += end - start;
      if (!dropping && lineBytes > maxBytes) { dropping = true; skippedLines++; parts = []; decoder = new StringDecoder("utf8"); }
      if (!dropping) parts.push(decoder.write(buf.subarray(start, end)));
      if (complete) {
        // Empty placeholders preserve byte offsets for search even when a record is skipped.
        out.push({ line: dropping ? "" : parts.join("") + decoder.end(), byteLength: lineBytes + 1 });
        reset();
      }
      start = complete ? end + 1 : size;
    }
    return out;
  };
  return {
    get skippedLines() { return skippedLines; },
    pushWithOffsets,
    push: (buf, bytesRead) => pushWithOffsets(buf, bytesRead).map(value => value.line),
    end: () => { const value = dropping ? "" : parts.join("") + decoder.end(); reset(); return value; },
  };
}
