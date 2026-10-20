import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bot } from "grammy";
import { InboxLog } from "../src/storage/inbox-log.js";
import { InboxProcessor } from "../src/services/process-message.js";
import { DeepSeekClassifier } from "../src/ai/classifier.js";
import { NotionStore, createNotionClient } from "../src/notion/client.js";
import { installTelegramHandlers, TelegramNotifier } from "../src/bot/telegram.js";

test("one real handler path crosses the classifier and Notion adapters with exact source fields", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "inbox-complete-test-"));
  const log = new InboxLog(directory);
  t.after(() => { log.close(); rmSync(directory, { recursive: true, force: true }); });
  const entries = [
    { title: "Call the dentist", content: "Call the dentist.", category: "Task", project: null, tags: [], dueDate: null },
    { title: "Saved link", content: "https://example.invalid/article", category: "Reference", project: null, tags: [], dueDate: null },
  ];
  const aiFetch: typeof fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ entries }) } }],
  }));
  const writes: Record<string, unknown>[] = [];
  const notionFetch: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/query")) return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    writes.push(body);
    return new Response(JSON.stringify({
      object: "page", id: "synthetic-page-" + writes.length, url: "https://example.invalid/note/" + writes.length,
    }));
  };
  const bot = new Bot("synthetic", { botInfo: {
    id: 99, is_bot: true, first_name: "Synthetic", username: "synthetic_bot",
    can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
    allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
  } });
  const replies: string[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === "sendMessage" && "text" in payload) replies.push(String(payload.text));
    return { ok: true, result: {} } as never;
  });
  const worker = new InboxProcessor(log, new DeepSeekClassifier("synthetic", "synthetic", aiFetch),
    new NotionStore(createNotionClient("synthetic", notionFetch), "source"), new TelegramNotifier(bot));
  installTelegramHandlers(bot, { allowedUserId: "1", timezone: "Etc/UTC", log, processor: worker, kick: () => {} });
  const text = "Call the dentist.\nSave this: https://example.invalid/article";
  await bot.handleUpdate({ update_id: 100, message: {
    message_id: 10, date: 1792368000, from: { id: 1, is_bot: false, first_name: "Synthetic" },
    chat: { id: 1, type: "private", first_name: "Synthetic" }, text,
  } });
  await worker.drain();
  assert.equal(log.get("1:10")?.confirmed, true);
  assert.equal(writes.length, 2);
  for (const [index, request] of writes.entries()) {
    const properties = request.properties as Record<string, { rich_text?: { text: { content: string } }[]; select?: { name: string } }>;
    assert.equal(properties.Status?.select?.name, "Inbox");
    assert.equal(properties["Source ID"]?.rich_text?.[0]?.text.content, "1:10");
    assert.equal(properties["Item ID"]?.rich_text?.[0]?.text.content, "1:10:" + index);
    const blocks = request.children as { paragraph?: { rich_text: { text: { content: string } }[] } }[];
    assert.equal(blocks.at(-1)?.paragraph?.rich_text.map((part) => part.text.content).join(""), text);
  }
  assert(replies.at(-1)?.includes("https://example.invalid/note/1"));
  assert(replies.at(-1)?.includes("https://example.invalid/note/2"));
});

