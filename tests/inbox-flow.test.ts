import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Bot, GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { InboxLog, recoverLock } from "../src/storage/inbox-log.js";
import { InboxProcessor, type Classifier, type NoteStore, type Notifier } from "../src/services/process-message.js";
import { acceptText, installTelegramHandlers, pollTelegram, TelegramNotifier } from "../src/bot/telegram.js";
import { ProviderError, StorageError } from "../src/errors.js";
import { itemId, type Capture, type Entry, type SavedPage } from "../src/schemas/note.js";

const entries: Entry[] = [
  { title: "Call the dentist", content: "Call the dentist.", category: "Task", project: null, tags: [], dueDate: null },
  { title: "Herb shelf", content: "Build a herb shelf.", category: "Idea", project: null, tags: ["home"], dueDate: null },
];
const capture: Capture = {
  sourceId: "1:10", updateId: "100", chatId: "1", messageId: "10", userId: "1",
  capturedAt: "2026-10-18T23:00:00.000Z", timezone: "Etc/UTC",
  text: "Call the dentist.\nIdea: build a herb shelf. 🌱",
};
function update(id = 10, text = capture.text): Update {
  return { update_id: id + 90, message: {
    message_id: id, date: Date.parse(capture.capturedAt) / 1000,
    from: { id: 1, is_bot: false, first_name: "Synthetic" },
    chat: { id: 1, type: "private", first_name: "Synthetic" }, text,
  } };
}
function context(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "inbox-test-"));
  const box = { directory, log: new InboxLog(directory) };
  t.after(() => { box.log.close(); rmSync(directory, { recursive: true, force: true }); });
  return box;
}
function harness(log: InboxLog, options: { now?: () => number } = {}) {
  const pages = new Map<string, SavedPage>();
  const created: string[] = [];
  let classifications = 0;
  let confirmations = 0;
  let notices = 0;
  const classifier: Classifier = { async classify() { classifications++; return entries; } };
  const store: NoteStore = {
    async hasSource(sourceId) { return [...pages.keys()].some((id) => id.startsWith(sourceId + ":")); },
    async find(id) { return pages.has(id) ? [pages.get(id)!] : []; },
    async save(event, _entry, index) {
      const id = itemId(event, index);
      created.push(id);
      const page = { id, url: "https://example.invalid/" + encodeURIComponent(id) };
      pages.set(id, page);
      return page;
    },
  };
  const notifier: Notifier = {
    async saved(_event, _entries, saved) { assert.equal(saved.size, 2); confirmations++; },
    async pending() { notices++; },
  };
  return {
    pages, created, store, notifier, classifier,
    stats: () => ({ classifications, confirmations, notices }),
    processor: new InboxProcessor(log, classifier, store, notifier, { ...options, retryBaseMs: 0 }),
  };
}

test("authorized text survives restart exactly; repeated updates do not create another capture", async (t) => {
  const box = context(t);
  assert.equal(acceptText(update(), "1", "Etc/UTC", box.log).kind, "accepted");
  const journal = readFileSync(join(box.directory, "inbox.jsonl"), "utf8");
  assert.equal(JSON.parse(journal.trim()).event.capture.text, capture.text);
  assert.equal(statSync(join(box.directory, "inbox.jsonl")).mode & 0o777, 0o600);
  box.log.close();
  box.log = new InboxLog(box.directory);
  assert.equal(box.log.get(capture.sourceId)?.capture.text, capture.text);
  assert.equal(acceptText(update(), "1", "Etc/UTC", box.log).kind, "duplicate");
  const h = harness(box.log);
  await h.processor.drain();
  await h.processor.drain();
  assert.equal(h.created.length, 2);
  assert.equal(h.stats().classifications, 1);
  assert.equal(h.stats().confirmations, 1);
});

test("unauthorized, group, edited, and non-text updates never enter the durable queue", (t) => {
  const { log, directory } = context(t);
  assert.equal(acceptText(update(), "2", "Etc/UTC", log).kind, "ignored");
  const group = update();
  group.message!.chat = { id: -1, type: "group", title: "Synthetic group" };
  assert.equal(acceptText(group, "1", "Etc/UTC", log).kind, "ignored");
  const edited: Update = { update_id: 101, edited_message: { ...update().message!, edit_date: 1000 } };
  assert.equal(acceptText(edited, "1", "Etc/UTC", log).kind, "ignored");
  const media = update();
  delete media.message!.text;
  assert.equal(acceptText(media, "1", "Etc/UTC", log).kind, "unsupported");
  assert.equal(readFileSync(join(directory, "inbox.jsonl"), "utf8"), "");
});

test("partial multi-item failure resumes without another model call or another first page", async (t) => {
  const box = context(t);
  box.log.record({ type: "capture", capture });
  let now = Date.now();
  const h = harness(box.log, { now: () => now });
  const save = h.store.save.bind(h.store);
  let fail = true;
  h.store.save = async (...args) => {
    if (args[2] === 1 && fail) throw new ProviderError("notion_http_429", { retryable: true, retryAfterMs: 1000 });
    return save(...args);
  };
  await h.processor.drain();
  assert.deepEqual(h.created, ["1:10:0"]);
  assert.equal(box.log.get(capture.sourceId)?.failure?.operation, "notion:1");
  box.log.close();
  box.log = new InboxLog(box.directory);
  fail = false;
  now += 60000;
  const worker = new InboxProcessor(box.log, h.classifier, h.store, h.notifier, { now: () => now });
  await worker.drain();
  assert.deepEqual(h.created, ["1:10:0", "1:10:1"]);
  assert.equal(h.stats().classifications, 1);
  assert.equal(box.log.status().pending, 0);
});

test("an uncertain create that committed is reconciled without another page creation", async (t) => {
  const { log } = context(t);
  log.record({ type: "capture", capture });
  const h = harness(log);
  const save = h.store.save.bind(h.store);
  let once = true;
  h.store.save = async (...args) => {
    const page = await save(...args);
    if (once) { once = false; throw new ProviderError("notion_network_error", { retryable: true, ambiguous: true }); }
    return page;
  };
  await h.processor.drain();
  assert(log.get(capture.sourceId)?.intents.has(0));
  h.processor.retryFailed();
  await h.processor.drain();
  assert.deepEqual(h.created, ["1:10:0", "1:10:1"]);
  assert.equal(log.status().pending, 0);
});

test("an uncertain create with no visible page blocks for review instead of blindly repeating the write", async (t) => {
  const { log } = context(t);
  log.record({ type: "capture", capture });
  const h = harness(log);
  let attempts = 0;
  h.store.save = async () => { attempts++; throw new ProviderError("notion_network_error", { ambiguous: true }); };
  await h.processor.drain();
  h.processor.retryFailed();
  await h.processor.drain();
  assert.equal(attempts, 1);
  assert.equal(log.get(capture.sourceId)?.failure?.code, "uncertain_write_needs_review");
  assert.equal(log.status().needsReview, 1);
});

test("a failed confirmation resends the reply without another extraction or Notion write", async (t) => {
  const { log } = context(t);
  log.record({ type: "capture", capture });
  const h = harness(log);
  let attempts = 0;
  h.notifier.saved = async () => {
    if (++attempts === 1) throw new ProviderError("telegram_confirmation_failed", { retryable: true });
  };
  await h.processor.drain();
  assert.equal(h.created.length, 2);
  assert.equal(log.status().pending, 1);
  h.processor.retryFailed();
  await h.processor.drain();
  assert.equal(attempts, 2);
  assert.equal(h.created.length, 2);
  assert.equal(h.stats().classifications, 1);
  assert.equal(log.status().pending, 0);
});

test("invalid classification exhausts its retry budget while retaining the original input", async (t) => {
  const { log } = context(t);
  log.record({ type: "capture", capture });
  let now = Date.now();
  const h = harness(log, { now: () => now });
  let calls = 0;
  h.classifier.classify = async () => { calls++; return []; };
  for (let i = 0; i < 5; i++) { await h.processor.drain(); now += 60000; }
  assert.equal(calls, 3);
  assert.equal(h.created.length, 0);
  assert.equal(log.get(capture.sourceId)?.capture.text, capture.text);
  assert.equal(log.status().needsReview, 1);
});

test("a restored capture without its extraction cannot reclassify pages that already exist", async (t) => {
  const { log } = context(t);
  log.record({ type: "capture", capture });
  const h = harness(log);
  h.pages.set("1:10:0", { id: "old-page", url: "https://example.invalid/old-page" });
  await h.processor.drain();
  assert.equal(h.stats().classifications, 0);
  assert.equal(h.created.length, 0);
  assert.equal(log.get(capture.sourceId)?.failure?.code, "extraction_missing_needs_review");
});

test("a restored valid extraction finds existing pages without overwriting owner edits", async (t) => {
  const { log } = context(t);
  log.record({ type: "capture", capture });
  log.record({ type: "extraction", sourceId: capture.sourceId, entries });
  const h = harness(log);
  h.pages.set("1:10:0", { id: "edited-page", url: "https://example.invalid/edited-page" });
  h.pages.set("1:10:1", { id: "other-page", url: "https://example.invalid/other-page" });
  await h.processor.drain();
  assert.equal(h.created.length, 0);
  assert.equal(h.stats().classifications, 0);
  assert.equal(log.get(capture.sourceId)?.pages.get(0)?.id, "edited-page");
});

test("hard process death preserves synced input and an item intent; recovery never duplicates a committed page", async (t) => {
  const box = context(t);
  box.log.close();
  const moduleUrl = pathToFileURL(resolve("dist/src/storage/inbox-log.js")).href;
  const script = [
    "import { InboxLog } from " + JSON.stringify(moduleUrl) + ";",
    "const log = new InboxLog(" + JSON.stringify(box.directory) + ");",
    "log.record(" + JSON.stringify({ type: "capture", capture }) + ");",
    "log.record(" + JSON.stringify({ type: "extraction", sourceId: capture.sourceId, entries }) + ");",
    "log.record(" + JSON.stringify({ type: "intent", sourceId: capture.sourceId, index: 0 }) + ");",
    'process.kill(process.pid, "SIGKILL");',
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.signal, "SIGKILL", child.stderr);
  assert.throws(() => new InboxLog(box.directory), /process_lock_exists/);
  recoverLock(box.directory);
  box.log = new InboxLog(box.directory);
  assert.equal(box.log.get(capture.sourceId)?.capture.text, capture.text);
  const h = harness(box.log);
  h.pages.set("1:10:0", { id: "already-committed", url: "https://example.invalid/committed" });
  await h.processor.drain();
  assert.deepEqual(h.created, ["1:10:1"]);
  assert.equal(box.log.status().pending, 0);
});

test("a live owner lock cannot be removed; incomplete journals remain intact", (t) => {
  const box = context(t);
  assert.throws(() => recoverLock(box.directory), /lock_owner_alive/);
  assert.throws(() => new InboxLog(box.directory), /process_lock_exists/);
  box.log.close();
  const path = join(box.directory, "inbox.jsonl");
  writeFileSync(path, '{"incomplete":');
  assert.throws(() => new InboxLog(box.directory), /journal_incomplete_record/);
  assert.equal(readFileSync(path, "utf8"), '{"incomplete":');
});

test("concurrent worker kicks run one classification and one delivery per item", async (t) => {
  const { log } = context(t);
  log.record({ type: "capture", capture });
  const h = harness(log);
  await Promise.all([h.processor.drain(), h.processor.drain(), h.processor.drain()]);
  assert.equal(h.stats().classifications, 1);
  assert.equal(h.created.length, 2);
});

function syntheticBot() {
  return new Bot("synthetic-token", { botInfo: {
    id: 99, is_bot: true, first_name: "Synthetic Bot", username: "synthetic_inbox_bot",
    can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
    allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
  } });
}

test("actual Telegram middleware persists capture even when its receipt reply fails", async (t) => {
  const { log } = context(t);
  const h = harness(log);
  const bot = syntheticBot();
  bot.api.config.use(async () => { throw new Error("Synthetic reply failure"); });
  let kicks = 0;
  installTelegramHandlers(bot, { allowedUserId: "1", timezone: "Etc/UTC", log, processor: h.processor, kick: () => { kicks++; } });
  await bot.handleUpdate(update());
  assert.equal(log.get(capture.sourceId)?.capture.text, capture.text);
  assert.equal(kicks, 1);
  await bot.handleUpdate(update());
  assert.equal(log.messages().length, 1);
});

test("custom long polling never advances its offset past a failed durable write", async (t) => {
  const { log } = context(t);
  const h = harness(log);
  const bot = syntheticBot();
  const offsets: unknown[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === "getUpdates") {
      offsets.push("offset" in payload ? payload.offset : undefined);
      return { ok: true, result: [update(10), update(11)] } as never;
    }
    return { ok: true, result: {} } as never;
  });
  bot.use(async (ctx, next) => {
    if (ctx.message?.message_id === 11) log.close();
    await next();
  });
  installTelegramHandlers(bot, { allowedUserId: "1", timezone: "Etc/UTC", log, processor: h.processor, kick: () => {} });
  await assert.rejects(pollTelegram(bot, new AbortController().signal), StorageError);
  assert.deepEqual(offsets, [undefined]);
  const records = readFileSync(join(log.directory, "inbox.jsonl"), "utf8").trim().split("\n");
  assert.equal(records.length, 1);
  assert.equal(JSON.parse(records[0]!).event.capture.messageId, "10");
});


test("real backup copies restore in isolation without remapping or duplicating existing notes", async (t) => {
  const original = context(t);
  original.log.record({ type: "capture", capture });
  const captureOnlyBackup = readFileSync(join(original.directory, "inbox.jsonl"));
  original.log.record({ type: "extraction", sourceId: capture.sourceId, entries });
  const extractedBackup = readFileSync(join(original.directory, "inbox.jsonl"));
  const h = harness(original.log);
  await h.processor.drain();
  original.log.close();
  assert.equal(h.created.length, 2);
  for (const [backup, expected] of [[captureOnlyBackup, "review"], [extractedBackup, "confirmed"]] as const) {
    const restored = context(t);
    restored.log.close();
    writeFileSync(join(restored.directory, "inbox.jsonl"), backup);
    restored.log = new InboxLog(restored.directory);
    await new InboxProcessor(restored.log, h.classifier, h.store, h.notifier).drain();
    if (expected === "review") {
      assert.equal(restored.log.get(capture.sourceId)?.failure?.code, "extraction_missing_needs_review");
    } else {
      assert.equal(restored.log.status().pending, 0);
    }
    assert.equal(h.created.length, 2);
    assert.equal(h.stats().classifications, 0);
  }
});

test("provider Retry-After pauses other queued captures and survives a restart or manual retry", async (t) => {
  const box = context(t);
  box.log.record({ type: "capture", capture });
  box.log.record({ type: "capture", capture: { ...capture, sourceId: "1:11", messageId: "11", updateId: "101" } });
  let now = Date.now();
  const h = harness(box.log, { now: () => now });
  let attempts = 0;
  h.store.save = async () => {
    attempts++;
    throw new ProviderError("notion_http_429", { retryable: true, retryAfterMs: 120000 });
  };
  await h.processor.drain();
  assert.equal(attempts, 1);
  assert.equal(h.stats().classifications, 1);
  box.log.close();
  box.log = new InboxLog(box.directory);
  const worker = new InboxProcessor(box.log, h.classifier, h.store, h.notifier, { now: () => now });
  worker.retryFailed();
  await worker.drain();
  assert.equal(attempts, 1);
  now += 120001;
  await worker.drain();
  assert.equal(attempts, 2);
});


test("Telegram confirmation rate limits retain Retry-After without an immediate extra notice", async (t) => {
  const { log } = context(t);
  log.record({ type: "capture", capture });
  const h = harness(log);
  const bot = syntheticBot();
  let calls = 0;
  bot.api.config.use(async () => {
    calls++;
    throw new GrammyError("Synthetic limit", {
      ok: false, error_code: 429, description: "Synthetic limit", parameters: { retry_after: 120 },
    }, "sendMessage", {});
  });
  let now = Date.now();
  const worker = new InboxProcessor(log, h.classifier, h.store, new TelegramNotifier(bot), { now: () => now });
  await worker.drain();
  assert.equal(calls, 1);
  assert.equal(Date.parse(log.get(capture.sourceId)!.failure!.retryAt!), now + 120000);
  worker.retryFailed();
  now += 119000;
  await worker.drain();
  assert.equal(calls, 1);
  now += 1001;
  await worker.drain();
  assert.equal(calls, 2);
  assert.equal(h.created.length, 2);
});

