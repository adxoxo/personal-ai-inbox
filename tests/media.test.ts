import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bot, GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { SourceContent, extractLinks, publicUrl } from "../src/services/content.js";
import { InboxProcessor } from "../src/services/process-message.js";
import { InboxLog } from "../src/storage/inbox-log.js";
import { DeepSeekClassifier } from "../src/ai/classifier.js";
import { createNotionClient, NotionStore } from "../src/notion/client.js";
import { acceptText, installTelegramHandlers, TelegramNotifier, telegramImageDownload } from "../src/bot/telegram.js";
import { MAX_IMAGE_BYTES, type Capture, type Entry } from "../src/schemas/note.js";
import { ProviderError } from "../src/errors.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
const entry: Entry = { title: "Saved image", content: "A saved image.", category: "Reference", project: null, tags: [], dueDate: null };
function photo(id = 10): Update {
  return { update_id: id + 100, message: { message_id: id, date: 1792368000,
    from: { id: 1, is_bot: false, first_name: "Synthetic" },
    chat: { id: 1, type: "private", first_name: "Synthetic" },
    photo: [{ file_id: "small", file_unique_id: "small", width: 1, height: 1 },
      { file_id: "large", file_unique_id: "large", width: 10, height: 10, file_size: png.length }],
  } };
}
function directory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "inbox-media-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const capture: Capture = { sourceId: "1:10", updateId: "110", chatId: "1", messageId: "10", userId: "1",
  capturedAt: "2026-10-18T00:00:00.000Z", timezone: "Asia/Manila", text: "https://example.com/article" };

function bot(): Bot {
  return new Bot("synthetic", { botInfo: {
    id: 99, is_bot: true, first_name: "Synthetic", username: "synthetic_bot",
    can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
    allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
  } });
}

test("photo intake preserves captionless metadata; image documents preserve captions and hidden links", (t) => {
  const log = new InboxLog(directory(t)); t.after(() => log.close());
  const result = acceptText(photo(), "1", "Asia/Manila", log);
  assert.equal(result.kind, "accepted");
  assert.equal(log.get("1:10")?.capture.text, "");
  assert.equal(log.get("1:10")?.capture.image?.fileId, "large");
  const update = photo(11);
  const message = update.message!;
  delete message.photo;
  message.document = { file_id: "document", file_unique_id: "document", mime_type: "image/png", file_size: png.length };
  message.caption = "  Save this screenshot  ";
  message.caption_entities = [{ type: "text_link", offset: 2, length: 4, url: "https://example.com" }];
  assert.equal(acceptText(update, "1", "Asia/Manila", log).kind, "accepted");
  assert.equal(log.get("1:11")?.capture.text, message.caption);
  assert.deepEqual(log.get("1:11")?.capture.links, ["https://example.com"]);
  assert.equal(acceptText(update, "1", "Asia/Manila", log).kind, "duplicate");
  const oversized = photo(12); oversized.message!.photo!.at(-1)!.file_size = MAX_IMAGE_BYTES + 1;
  assert.equal(acceptText(oversized, "1", "Asia/Manila", log).kind, "unsupported");
});

test("actual image handler crosses vision, Fetch, and multipart Notion adapters; confirmation retry reuses all writes", async (t) => {
  const dir = directory(t); let log = new InboxLog(dir); t.after(() => log.close());
  const telegram = bot(); const replies: string[] = [];
  let failConfirmation = true;
  telegram.api.config.use(async (_previous, method, payload) => {
    if (method === "sendMessage" && "text" in payload) {
      replies.push(String(payload.text));
      if (String(payload.text).startsWith("Saved") && failConfirmation) {
        failConfirmation = false; throw new Error("Synthetic reply failure");
      }
    }
    return { ok: true, result: {} } as never;
  });
  let downloads = 0, fetches = 0, classifications = 0, uploads = 0;
  const content = new SourceContent("synthetic", dir, async (fileId) => {
    downloads++; assert.equal(fileId, "large"); return new Response(png);
  }, async (_input, init) => {
    fetches++; assert.deepEqual(JSON.parse(String(init?.body)), { url: "https://example.com/article" });
    return Response.json({ title: "Garden", content: "A page about basil." });
  });
  const ai = new DeepSeekClassifier("synthetic", "synthetic", async (_input, init) => {
    classifications++;
    const body = JSON.parse(String(init?.body));
    const parts = body.messages[1].content;
    assert.equal(parts[1].image_url.url, "data:image/png;base64," + png.toString("base64"));
    const data = JSON.parse(parts[0].text);
    assert.equal(data.links[0].content, "A page about basil.");
    assert.equal(data.text, "https://example.com/article");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ entries: [entry] }) } }] });
  });
  const writes: Record<string, any>[] = [];
  const request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/query")) return Response.json({ results: [], has_more: false });
    if (path.endsWith("/file_uploads")) {
      uploads++; return Response.json({ id: "upload-1", status: "pending" });
    }
    if (path.endsWith("/send")) {
      assert(init?.body instanceof FormData);
      const file = init.body.get("file") as File;
      assert.equal(file.type, "image/png");
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
      return Response.json({ id: "upload-1", status: "uploaded", expiry_time: "2026-10-19T00:00:00.000Z" });
    }
    writes.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "page-1", url: "https://example.com/note" });
  };
  const store = new NotionStore(createNotionClient("synthetic", request), "source");
  let worker = new InboxProcessor(log, ai, store, new TelegramNotifier(telegram), { content, now: () => 1792368000000 });
  installTelegramHandlers(telegram, { allowedUserId: "1", timezone: "Asia/Manila", log, processor: worker, kick: () => {} });
  const unauthorized = photo(9); unauthorized.message!.from!.id = 2;
  await telegram.handleUpdate(unauthorized); await worker.drain();
  assert.equal(downloads, 0); assert.equal(log.messages().length, 0);
  const update = photo(); update.message!.caption = "https://example.com/article";
  await telegram.handleUpdate(update); await worker.drain();
  assert.equal(log.get("1:10")?.failure?.operation, "confirm");
  assert.equal(writes.length, 1);
  const page = writes[0]!;
  assert.equal(page.properties.Status.select.name, "Inbox");
  assert.equal(page.properties["Item ID"].rich_text[0].text.content, "1:10:0");
  assert.equal(page.children.find((b: any) => b.type === "image").image.file_upload.id, "upload-1");
  assert(page.children.some((b: any) => JSON.stringify(b).includes("A page about basil.")));
  assert.equal(page.children.at(-1).paragraph.rich_text[0].text.content, update.message!.caption);
  assert.equal(JSON.stringify(page).includes("api.telegram.org"), false);
  const originalContext = log.get("1:10")!.context!;
  const mediaPath = join(dir, "media", originalContext.image!.hash);
  assert.equal(statSync(mediaPath).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(mediaPath), png);
  await worker.stop(); log.close();
  log = new InboxLog(dir);
  worker = new InboxProcessor(log, ai, store, new TelegramNotifier(telegram), { content });
  worker.retryFailed(); await worker.drain();
  assert.equal(log.get("1:10")?.confirmed, true);
  assert.deepEqual({ downloads, fetches, classifications, uploads, pages: writes.length },
    { downloads: 1, fetches: 1, classifications: 1, uploads: 1, pages: 1 });
  assert(replies.at(-1)?.includes("https://example.com/note"));
});

test("source caches survive a full data backup and avoid refetch after a pre-extraction restart", async (t) => {
  const dir = directory(t); const restored = join(directory(t), "restored");
  let downloads = 0, fetches = 0;
  const download = async () => { downloads++; return new Response(png); };
  const request: typeof fetch = async () => { fetches++; return Response.json({ title: "Saved", content: "Stable content" }); };
  const withImage = { ...capture, image: { fileId: "file", uniqueId: "unique", mime: "image/png" as const } };
  const original = await new SourceContent("synthetic", dir, download, request).prepare(withImage);
  cpSync(dir, restored, { recursive: true });
  const service = new SourceContent("synthetic", restored, download, request);
  assert.deepEqual(await service.prepare(withImage), original);
  assert.deepEqual(service.image(original)?.bytes, png);
  assert.deepEqual({ downloads, fetches }, { downloads: 1, fetches: 1 });
});

test("unavailable or blocked pages retain URLs and cannot provide invented context", async (t) => {
  let calls = 0;
  const content = new SourceContent("synthetic", directory(t), async () => new Response(png), async () => {
    calls++; return new Response("unavailable", { status: 404 });
  });
  const first = await content.prepare({ ...capture, text: "https://example.com/article https://127.0.0.1/private https://user:secret@example.com/" });
  assert.deepEqual(first.links.map((link) => [link.status, link.content]), [["unavailable", ""], ["blocked", ""], ["blocked", ""]]);
  assert.equal(first.links[0]?.url, "https://example.com/article");
  await content.prepare({ ...capture, text: "https://example.com/article" });
  assert.equal(calls, 1);
  for (const value of ["http://localhost/a", "http://[::1]/", "ftp://example.com", "https://a.local/a", "http://router.lan/", "http://router.home.arpa/", "http://localhost./"]) assert.equal(publicUrl(value), false);
  assert.deepEqual(extractLinks("https://example.com/a. https://example.com/a https://example.org/x", ["https://example.net"]),
    ["https://example.com/a", "https://example.org/x", "https://example.net"]);
});

test("actual image byte limits and signatures are checked before vision or Notion", async (t) => {
  for (const response of [new Response("not an image"), new Response(png, { headers: { "content-length": String(MAX_IMAGE_BYTES + 1) } })]) {
    const service = new SourceContent("synthetic", directory(t), async () => response);
    await assert.rejects(service.prepare({ ...capture, text: "", image: { fileId: "file", uniqueId: "unique", mime: "image/png" } }),
      (error: unknown) => error instanceof ProviderError && ["image_format_invalid", "source_too_large"].includes(error.code));
  }
});

test("Fetch Retry-After uses the durable worker cooldown and retains the captured URL", async (t) => {
  const dir = directory(t); const log = new InboxLog(dir); t.after(() => log.close());
  log.record({ type: "capture", capture });
  const service = new SourceContent("synthetic", dir, async () => new Response(png),
    async () => new Response("limited", { status: 429, headers: { "retry-after": "120" } }));
  const worker = new InboxProcessor(log, { async classify() { throw new Error("Must wait"); } },
    { async hasSource() { return false; }, async find() { return []; }, async save() { throw new Error("Must wait"); } },
    { async saved() {}, async pending() { throw new Error("No extra notice during cooldown"); } },
    { content: service, now: () => 1792368000000 });
  await worker.drain();
  assert.equal(log.get(capture.sourceId)?.failure?.operation, "prepare");
  assert.equal(log.get(capture.sourceId)?.providerPauseUntil, 1792368120000);
  assert.equal(log.get(capture.sourceId)?.capture.text, capture.text);
});


test("Telegram getFile cooldown survives the download adapter and pauses later image captures", async (t) => {
  const dir = directory(t); const log = new InboxLog(dir); t.after(() => log.close());
  acceptText(photo(), "1", "Asia/Manila", log);
  acceptText(photo(11), "1", "Asia/Manila", log);
  const telegram = bot(); let calls = 0;
  telegram.api.config.use(async () => {
    calls++;
    throw new GrammyError("Synthetic limit", { ok: false, error_code: 429, description: "Too Many Requests",
      parameters: { retry_after: 120 } }, "getFile", { file_id: "large" });
  });
  const download = telegramImageDownload(telegram, "synthetic", async () => { throw new Error("Must not download"); });
  const worker = new InboxProcessor(log, { async classify() { throw new Error("Must wait"); } },
    { async hasSource() { return false; }, async find() { return []; }, async save() { throw new Error("Must wait"); } },
    { async saved() {}, async pending() { throw new Error("No extra notice during cooldown"); } },
    { content: new SourceContent("synthetic", dir, download), now: () => 1792368000000 });
  await worker.drain();
  assert.equal(calls, 1);
  assert.equal(log.get("1:10")?.providerPauseUntil, 1792368120000);
  assert.equal(log.get("1:11")?.failure, undefined);
});

test("captionless images reach vision and retain an empty original caption", async (t) => {
  const dir = directory(t); const log = new InboxLog(dir); t.after(() => log.close());
  acceptText(photo(), "1", "Asia/Manila", log);
  let sawImage = false, sawCaption = false;
  const ai = new DeepSeekClassifier("synthetic", "synthetic", async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    sawImage = body.messages[1].content[1].image_url.url.startsWith("data:image/png;base64,");
    assert.equal(JSON.parse(body.messages[1].content[0].text).text, "");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ entries: [entry] }) } }] });
  });
  const worker = new InboxProcessor(log, ai,
    { async hasSource() { return false; }, async find() { return []; },
      async uploadImage() { return { id: "upload", expiresAt: "2099-01-01T00:00:00.000Z" }; },
      async save(original) { sawCaption = original.text === ""; return { id: "page", url: "https://example.com/page" }; } },
    { async saved() {}, async pending() {} },
    { content: new SourceContent("synthetic", dir, async () => new Response(png)) });
  await worker.drain();
  assert(sawImage && sawCaption);
  assert.equal(log.get("1:10")?.confirmed, true);
});
