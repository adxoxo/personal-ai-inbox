import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNotionClient, NotionStore, pageParameters, notionProperties } from "../src/notion/client.js";
import { setupNotion } from "../src/notion/setup.js";
import { DeepSeekClassifier } from "../src/ai/classifier.js";
import { runtimeConfig } from "../src/config.js";
import { entrySchema, type Capture, type Entry } from "../src/schemas/note.js";
import { ProviderError } from "../src/errors.js";

const capture: Capture = {
  sourceId: "1:10", updateId: "100", chatId: "1", messageId: "10", userId: "1",
  capturedAt: "2026-10-18T23:00:00.000Z", timezone: "Asia/Manila", text: "Call the dentist tomorrow.",
};
const entry: Entry = {
  title: "Call the dentist", content: "Call the dentist tomorrow.", category: "Task",
  project: null, tags: ["personal"], dueDate: "2026-10-20",
};
type Call = { path: string; method: string; body: Record<string, unknown> };
function transport(handler: (call: Call) => { body: unknown; status?: number; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const call = { path: new URL(url).pathname, method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} };
    calls.push(call);
    const response = handler(call);
    return new Response(JSON.stringify(response.body), {
      status: response.status || 200, headers: { "content-type": "application/json", ...response.headers },
    });
  };
  return { calls, request };
}
function schemaResponse() {
  return {
    object: "data_source", id: "source", parent: { type: "database_id", database_id: "database" },
    properties: Object.fromEntries(Object.entries(notionProperties).map(([name, property]) => {
      const type = Object.keys(property)[0]!;
      return [name, { ...property, type }];
    })),
  };
}
function directory(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "inbox-provider-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test("actual Notion SDK sends the expected destination, Inbox status, fields, and full Unicode original", async () => {
  const longCapture = { ...capture, text: "🌱".repeat(2200) + "\nAn exact original tail." };
  const http = transport((call) => {
    if (call.path.endsWith("/query")) return { body: { object: "list", results: [], has_more: false, next_cursor: null } };
    return { body: { object: "page", id: "page", url: "https://example.invalid/page" } };
  });
  const store = new NotionStore(createNotionClient("synthetic", http.request), "source", "database");
  assert.equal(await store.hasSource(capture.sourceId), false);
  assert.deepEqual(await store.find("1:10:0"), []);
  await store.save(longCapture, entry, 0);
  const write = http.calls.find((call) => call.path.endsWith("/pages"))!;
  assert.deepEqual(write.body.parent, { type: "data_source_id", data_source_id: "source" });
  const body = write.body as {
    properties: Record<string, { rich_text?: { text: { content: string } }[]; select?: { name: string }; date?: { start: string } }>;
    children: { paragraph?: { rich_text: { text: { content: string } }[] } }[];
  };
  assert.equal(body.properties.Status?.select?.name, "Inbox");
  assert.equal(body.properties.Category?.select?.name, "Task");
  assert.equal(body.properties["Source ID"]?.rich_text?.[0]?.text.content, "1:10");
  assert.equal(body.properties["Item ID"]?.rich_text?.[0]?.text.content, "1:10:0");
  assert.equal(body.properties["Captured At"]?.date?.start, capture.capturedAt);
  const chunks = body.children.at(-1)!.paragraph!.rich_text;
  assert.equal(chunks.map((piece) => piece.text.content).join(""), longCapture.text);
  assert(chunks.every((piece) => piece.text.content.length <= 2000));
});

test("Notion schema verification rejects wrong destination or missing fields before capture", async () => {
  const http = transport(() => ({ body: schemaResponse() }));
  await new NotionStore(createNotionClient("synthetic", http.request), "source", "database").verify();
  await assert.rejects(new NotionStore(createNotionClient("synthetic", http.request), "source", "other").verify(),
    /notion_destination_mismatch/);
  const invalid = schemaResponse();
  delete invalid.properties["Item ID"];
  const wrong = transport(() => ({ body: invalid }));
  await assert.rejects(new NotionStore(createNotionClient("synthetic", wrong.request), "source").verify(), /notion_schema_mismatch/);
});

test("Notion page-create errors remain ambiguous and SDK does not automatically repeat them", async () => {
  const http = transport(() => ({
    status: 503, body: { object: "error", status: 503, code: "service_unavailable", message: "Synthetic failure" },
  }));
  const store = new NotionStore(createNotionClient("synthetic", http.request), "source");
  await assert.rejects(store.save(capture, entry, 0), (error: unknown) => {
    assert(error instanceof ProviderError);
    assert.equal(error.ambiguous, true);
    return true;
  });
  assert.equal(http.calls.length, 1);
});

test("Notion rate limits preserve provider wait time", async () => {
  const http = transport(() => ({ status: 429, headers: { "retry-after": "120" },
    body: { object: "error", status: 429, code: "rate_limited", message: "Synthetic limit" } }));
  const store = new NotionStore(createNotionClient("synthetic", http.request), "source");
  await assert.rejects(store.save(capture, entry, 0), (error: unknown) => {
    assert(error instanceof ProviderError);
    assert.equal(error.retryAfterMs, 120000);
    assert.equal(error.ambiguous, false);
    return true;
  });
  assert.equal(http.calls.length, 1);
});

test("Notion setup creates once, persists destination IDs privately, and reuses the same database", async (t) => {
  const dir = directory(t);
  const http = transport((call) => {
    if (call.path.endsWith("/children")) return { body: { object: "list", results: [], has_more: false, next_cursor: null } };
    if (call.path.endsWith("/databases") && call.method === "POST") return { body: { object: "database", id: "database" } };
    if (call.path.includes("/databases/")) return { body: {
      object: "database", id: "database", parent: { type: "page_id", page_id: "parent" },
      data_sources: [{ id: "source", name: "Personal Inbox" }],
    } };
    return { body: schemaResponse() };
  });
  const client = createNotionClient("synthetic", http.request);
  assert.deepEqual(await setupNotion(client, "parent", dir), { databaseId: "database", dataSourceId: "source" });
  await setupNotion(client, "parent", dir);
  assert.equal(http.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(statSync(join(dir, "notion-setup.json")).mode & 0o777, 0o600);
  await assert.rejects(setupNotion(client, "different-parent", dir), /notion_destination_mismatch/);
});

test("uncertain database creation cannot blindly create a second database on setup rerun", async (t) => {
  const dir = directory(t);
  const http = transport((call) => call.path.endsWith("/children") ?
    { body: { object: "list", results: [], has_more: false, next_cursor: null } } :
    { status: 503, body: { object: "error", status: 503, code: "service_unavailable", message: "Synthetic timeout" } });
  const client = createNotionClient("synthetic", http.request);
  await assert.rejects(setupNotion(client, "parent", dir));
  await assert.rejects(setupNotion(client, "parent", dir), /notion_setup_uncertain_check_parent_page/);
  assert.equal(http.calls.filter((call) => call.method === "POST").length, 1);
});

test("DeepSeek request anchors dates to capture timezone and validates the response", async () => {
  let sent: Record<string, unknown> | undefined;
  const request: typeof fetch = async (_input, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{
      finish_reason: "stop", message: { content: JSON.stringify({ entries: [entry] }) },
    }] }), { status: 200 });
  };
  const classifier = new DeepSeekClassifier("synthetic", "test-model", request);
  assert.deepEqual(await classifier.classify(capture), [entry]);
  const messages = sent!.messages as { role: string; content: string }[];
  const data = JSON.parse(messages[1]!.content);
  assert.equal(data.localDate, "2026-10-19");
  assert.equal(data.text, capture.text);
  assert.deepEqual(sent!.response_format, { type: "json_object" });
});

test("DeepSeek empty or truncated output cannot become a Notion extraction", async () => {
  for (const choice of [
    { finish_reason: "stop", message: { content: "" } },
    { finish_reason: "length", message: { content: JSON.stringify({ entries: [entry] }) } },
  ]) {
    const request: typeof fetch = async () => new Response(JSON.stringify({ choices: [choice] }), { status: 200 });
    await assert.rejects(new DeepSeekClassifier("synthetic", "test-model", request).classify(capture), /classification_invalid/);
  }
  assert.equal(entrySchema.safeParse({ ...entry, dueDate: "2026-02-30" }).success, false);
  assert.equal(entrySchema.safeParse({ ...entry, category: "Reference" }).success, false);
});

test("live startup requires explicit credentials and a confirmed timezone without a key fallback", () => {
  assert.throws(() => runtimeConfig({ DATA_DIR: "/tmp/synthetic-only" }), /config_missing_user_timezone/);
  assert.throws(() => runtimeConfig({
    DATA_DIR: "/tmp/synthetic-only", USER_TIMEZONE: "Etc/UTC",
    ALLOWED_TELEGRAM_USER_ID: "1", TELEGRAM_BOT_TOKEN: "synthetic",
  }), /config_missing_deepseek_api_key/);
});


test("compact Notion IDs match canonical IDs from the API and persisted setup", async (t) => {
  const dir = directory(t);
  const parent = "01234567-89ab-cdef-0123-456789abcdef";
  const database = "11111111-1111-4111-8111-111111111111";
  const source = "22222222-2222-4222-8222-222222222222";
  const http = transport((call) => {
    if (call.path.includes("/databases/")) return { body: {
      object: "database", id: database, parent: { type: "page_id", page_id: parent },
      data_sources: [{ id: source, name: "Personal Inbox" }],
    } };
    const schema = schemaResponse();
    schema.parent.database_id = database;
    return { body: schema };
  });
  const client = createNotionClient("synthetic", http.request);
  const input = { databaseId: database.replaceAll("-", ""), dataSourceId: source.replaceAll("-", "") };
  const result = await setupNotion(client, parent.replaceAll("-", ""), dir, input);
  assert.deepEqual(result, { databaseId: database, dataSourceId: source });
  await setupNotion(client, parent.replaceAll("-", ""), dir, input);
  await new NotionStore(client, source, database.replaceAll("-", "")).verify();
  assert.equal(http.calls.some((call) => call.method === "POST"), false);
});

