import { Bot } from "grammy";
import { runtimeConfig } from "./config.js";
import { InboxLog } from "./storage/inbox-log.js";
import { DeepSeekClassifier } from "./ai/classifier.js";
import { createNotionClient, NotionStore } from "./notion/client.js";
import { InboxProcessor } from "./services/process-message.js";
import { installTelegramHandlers, pollTelegram, TelegramNotifier, telegramImageDownload } from "./bot/telegram.js";
import { SourceContent } from "./services/content.js";
import { safeCode } from "./errors.js";

async function main(): Promise<void> {
  const config = runtimeConfig();
  const log = new InboxLog(config.dataDir);
  const controller = new AbortController();
  const stop = () => controller.abort();
  let processor: InboxProcessor | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let fatal: unknown;
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const store = new NotionStore(createNotionClient(config.notionToken), config.dataSourceId, config.databaseId);
    await store.verify();
    const bot = new Bot(config.botToken, { client: { timeoutSeconds: 35 } });
    const content = new SourceContent(config.deepseekKey, config.dataDir, telegramImageDownload(bot, config.botToken));
    processor = new InboxProcessor(log, new DeepSeekClassifier(config.deepseekKey, config.deepseekModel),
      store, new TelegramNotifier(bot), { content });
    const worker = processor;
    const kick = () => {
      void worker.drain().catch((error: unknown) => { fatal = error; controller.abort(); });
    };
    installTelegramHandlers(bot, {
      allowedUserId: config.allowedUserId, timezone: config.timezone, log, processor, kick,
    });
    timer = setInterval(kick, 1000);
    kick();
    console.log("Inbox ready. Text, images, and public link context supported. Every note starts in Inbox.");
    await pollTelegram(bot, controller.signal);
    if (fatal) throw fatal;
  } finally {
    if (timer) clearInterval(timer);
    controller.abort();
    await processor?.stop();
    log.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch((error: unknown) => {
  console.error("Inbox stopped: " + safeCode(error) + ". Check setup or the local recovery instructions.");
  process.exitCode = 1;
});

