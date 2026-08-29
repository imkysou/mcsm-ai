import iconv from "iconv-lite";
import fs from "fs-extra";

/**
 * Encoding-tolerant text decoding for server files & logs.
 *
 * Minecraft on Chinese Windows used to write logs/config in the JVM default
 * charset (GBK/GB18030). Decoding those bytes as UTF-8 yields U+FFFD mojibake.
 * Strategy (same as the daemon): try UTF-8 first; if replacement characters
 * appear, fall back to GB18030.
 */
export function smartDecode(buf: Buffer): string {
  try {
    const utf8 = iconv.decode(buf, "utf-8");
    if (!utf8.includes("\ufffd")) return utf8;
    return iconv.decode(buf, "gb18030");
  } catch {
    return buf.toString("utf-8");
  }
}

/** Safe text read: buffer-level smart decoding. */
export async function readTextSmart(file: string): Promise<string> {
  const buf = await fs.readFile(file);
  return smartDecode(buf);
}
