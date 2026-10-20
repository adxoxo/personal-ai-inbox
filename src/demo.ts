import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "grammy/types";
import { InboxLog } from "./storage/inbox-log.js";
import { acceptText } from "./bot/telegram.js";
import { InboxProcessor } from "./services/process-message.js";
import type { Capture, Entry, SavedPage } from "./schemas/note.js";
import { itemId } from "./schemas/note.js";

const directory = mkdtempSync(join(tmpdir(), "personal-ai-inbox-demo-"));
const pages = new Map<string, SavedPage>();
let modelCalls = 0;
const classifier = { async classify(): Promise<Entry[]> {
  modelCalls++;
  return [
    { title: "Call the dentist", content: "Call the dentist.", category: "Task", project: null, tags: [], dueDate: null },
    { title: "Balcony herb shelf", content: "Build a balcony herb shelf.", category: "Idea", project: null, tags: ["home"], dueDate: null },
  ];
} };
const store = {
  async hasSource(sourceId: string) { return [...pages.keys()].some((id) => id.startsWith(sourceId + ":")); },
  async find(id: string) { return pages.has(id) ? [pages.get(id)!] : []; },
  async save(capture: Capture, _entry: Entry, index: number) {
    const id = itemId(capture, index);
    const page = { id, url: "https://example.invalid/demo/" + encodeURIComponent(id) };
    pages.set(id, page);
    return page;
  },
};
const notifier = { async saved() {}, async pending() {} };
const update: Update = {
  update_id: 100,
  message: { message_id: 10, date: Math.floor(Date.now() / 1000),
    from: { id: 1, is_bot: false, first_name: "Demo" },
    chat: { id: 1, type: "private", first_name: "Demo" },
    text: "Call the dentist. Idea: build a balcony herb shelf." },
};
let log = new InboxLog(directory);
try {
  const result = acceptText(update, "1", "Etc/UTC", log);
  await new InboxProcessor(log, classifier, store, notifier).drain();
  log.close();
  log = new InboxLog(directory);
  const replay = acceptText(update, "1", "Etc/UTC", log);
  await new InboxProcessor(log, classifier, store, notifier).drain();
  console.log(JSON.stringify({
    mode: "offline; synthetic providers only", accepted: result.kind,
    replay: replay.kind, notionPages: pages.size, classificationCalls: modelCalls,
    statusAfterRestart: log.status(), dataDirectory: directory,
  }, null, 2));
} finally { log.close(); }

