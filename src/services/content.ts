import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import type { ContentService } from "./process-message.js";
import { contextSchema, MAX_IMAGE_BYTES, type Capture, type ImageData, type SourceContext } from "../schemas/note.js";
import { ProviderError, StorageError } from "../errors.js";

const hash = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export function extractLinks(text: string, hidden: string[] = []): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  return [...new Set([...matches.map((url) => url.replace(/[.,;!?)\]}]+$/, "")), ...hidden])]
    .filter((url) => url.length <= 8192).slice(0, 3);
}

export function publicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    return value.length <= 8192 && ["https:", "http:"].includes(url.protocol) && !url.username && !url.password &&
      !isIP(host.replace(/^\[|\]$/g, "")) && host.includes(".") &&
      !["localhost", "local", "internal", "lan", "home", "home.arpa", "test", "invalid"].some((suffix) => host === suffix || host.endsWith("." + suffix));
  } catch { return false; }
}

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel(); throw new ProviderError("source_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError("source_empty");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ProviderError("source_too_large"); }
      parts.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts);
}

function imageMime(bytes: Uint8Array): ImageData["mime"] | undefined {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6))) return "image/gif";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

export class SourceContent implements ContentService {
  private media: string;
  private cache: string;
  constructor(private key: string, directory: string,
    private download: (fileId: string) => Promise<Response>, private request: typeof fetch = fetch) {
    this.media = join(directory, "media");
    this.cache = join(directory, "context-cache");
    try {
      for (const path of [this.media, this.cache]) mkdirSync(path, { recursive: true, mode: 0o700 });
      const parent = openSync(directory, "r");
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } catch { throw new StorageError("source_cache_unavailable"); }
  }

  private write(path: string, data: string | Uint8Array): void {
    const temporary = path + "." + randomUUID();
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path);
      const parent = path.startsWith(this.media + "/") ? this.media : this.cache;
      const dir = openSync(parent, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch { throw new StorageError("source_cache_write_failed"); }
  }

  private cached(path: string): unknown {
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new StorageError("source_cache_invalid"); }
  }

  image(context?: SourceContext): ImageData | undefined {
    if (!context?.image) return undefined;
    try {
      const bytes = readFileSync(join(this.media, context.image.hash));
      if (bytes.length !== context.image.bytes || hash(bytes) !== context.image.hash || imageMime(bytes) !== context.image.mime) {
        throw new Error("Invalid media");
      }
      return { bytes, mime: context.image.mime };
    } catch { throw new ProviderError("image_backup_missing_or_invalid"); }
  }

  async prepare(capture: Capture): Promise<SourceContext> {
    const context: SourceContext = { links: [] };
    if (capture.image) {
      const path = join(this.cache, hash(capture.sourceId + ":image:" + capture.image.uniqueId));
      if (existsSync(path)) {
        context.image = contextSchema.parse({ links: [], image: this.cached(path) }).image;
        this.image(context);
      } else {
        let response: Response;
        try { response = await this.download(capture.image.fileId); }
        catch (error) {
          if (error instanceof ProviderError) throw error;
          throw new ProviderError("telegram_image_download_failed", { retryable: true });
        }
        if (!response.ok) throw new ProviderError("telegram_image_http_" + response.status, {
          retryable: response.status === 429 || response.status >= 500,
          retryAfterMs: Math.max(0, Number(response.headers.get("retry-after")) || 0) * 1000,
        });
        let bytes: Uint8Array;
        try { bytes = await boundedBytes(response, MAX_IMAGE_BYTES); }
        catch (error) { if (error instanceof ProviderError) throw error;
          throw new ProviderError("telegram_image_download_failed", { retryable: true }); }
        const mime = imageMime(bytes);
        if (!mime) throw new ProviderError("image_format_invalid");
        context.image = { hash: hash(bytes), mime, bytes: bytes.length };
        this.write(join(this.media, context.image.hash), bytes);
        this.write(path, JSON.stringify(context.image));
      }
    }
    for (const url of extractLinks(capture.text, capture.links)) {
      const path = join(this.cache, hash(capture.sourceId + ":url:" + url));
      let link: SourceContext["links"][number];
      if (existsSync(path)) link = contextSchema.shape.links.element.parse(this.cached(path));
      else {
        link = await this.fetchLink(url);
        this.write(path, JSON.stringify(link));
      }
      context.links.push(link);
    }
    return contextSchema.parse(context);
  }

  private async fetchLink(url: string): Promise<SourceContext["links"][number]> {
    const unavailable = (code: string): SourceContext["links"][number] => ({ url, title: "", content: "", status: "unavailable", code });
    if (!publicUrl(url)) return { ...unavailable("url_not_public"), status: "blocked" };
    let response: Response;
    try {
      response = await this.request("https://api.deepseek.com/v1/tools/fetch", {
        method: "POST", headers: { Authorization: "Bearer " + this.key, "Content-Type": "application/json" },
        body: JSON.stringify({ url }), signal: AbortSignal.timeout(25000),
      });
    } catch { return unavailable("fetch_network_error"); }
    if (!response.ok) {
      await response.body?.cancel();
      if ([408, 429].includes(response.status) || response.status >= 500) {
        throw new ProviderError("fetch_http_" + response.status, { retryable: true,
          retryAfterMs: Math.max(0, Number(response.headers.get("retry-after")) || 0) * 1000 });
      }
      return unavailable("fetch_http_" + response.status);
    }
    try {
      const body = JSON.parse(Buffer.from(await boundedBytes(response, 2 * 1024 * 1024)).toString("utf8")) as { title?: unknown; content?: unknown };
      if (typeof body.content !== "string" || !body.content.trim()) return unavailable("fetch_empty");
      return { url, title: typeof body.title === "string" ? body.title.slice(0, 300) : "",
        content: body.content.slice(0, 12000), status: "fetched" };
    } catch { return unavailable("fetch_content_unavailable"); }
  }
}
