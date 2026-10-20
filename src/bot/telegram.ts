import { Bot, BotError, GrammyError, type Context } from "grammy";
import type { Update } from "grammy/types";
import { captureSchema, type Capture, type Entry, type SavedPage, MAX_IMAGE_BYTES, imageMimeSchema } from "../schemas/note.js";
import { InboxLog } from "../storage/inbox-log.js";
import { InboxProcessor, type Notifier } from "../services/process-message.js";
import { extractLinks } from "../services/content.js";
import { ProviderError } from "../errors.js";

export type IntakeResult = { kind: "ignored" | "unsupported" | "duplicate" } | { kind: "accepted"; capture: Capture };

export function acceptText(update: Update, allowedUserId: string, timezone: string, log: InboxLog): IntakeResult {
  const message = update.message;
  if (!message || message.chat.type !== "private" || String(message.from?.id) !== allowedUserId) return { kind: "ignored" };
  const photo = message.photo?.at(-1);
  const document = message.document;
  const mime = imageMimeSchema.safeParse(document?.mime_type);
  const image = photo ? { fileId: photo.file_id, uniqueId: photo.file_unique_id,
    mime: "image/jpeg" as const, ...(photo.file_size ? { size: photo.file_size } : {}) } :
    document && mime.success ? { fileId: document.file_id, uniqueId: document.file_unique_id,
      mime: mime.data, ...(document.file_size ? { size: document.file_size } : {}) } : undefined;
  if (image?.size && image.size > MAX_IMAGE_BYTES) return { kind: "unsupported" };
  const text = message.text ?? message.caption ?? "";
  if (!image && !message.text?.trim()) return { kind: "unsupported" };
  const hidden = [...(message.entities ?? []), ...(message.caption_entities ?? [])]
    .flatMap((entity) => entity.type === "text_link" ? [entity.url] : []);
  const links = extractLinks(text, hidden);
  const sourceId = String(message.chat.id) + ":" + message.message_id;
  if (log.get(sourceId)) return { kind: "duplicate" };
  const capture = captureSchema.parse({
    sourceId, updateId: String(update.update_id), chatId: String(message.chat.id),
    messageId: String(message.message_id), userId: String(message.from.id),
    capturedAt: new Date(message.date * 1000).toISOString(), timezone, text, ...(image ? { image } : {}), ...(links.length ? { links } : {}),
  });
  log.record({ type: "capture", capture });
  return { kind: "accepted", capture };
}

async function shortReply(ctx: Context, text: string): Promise<void> {
  try { await ctx.reply(text); } catch { /* A reply failure must not undo durable intake. */ }
}

export function installTelegramHandlers(
  bot: Bot, options: { allowedUserId: string; timezone: string; log: InboxLog; processor: InboxProcessor; kick: () => void },
): void {
  bot.use(async (ctx) => {
    const message = ctx.message;
    if (!message || message.chat.type !== "private" || String(message.from.id) !== options.allowedUserId) return;
    const command = message.text?.match(/^\/(start|help|status|retry)(?:@\w+)?(?:\s|$)/)?.[1];
    if (command === "start" || command === "help") {
      await shortReply(ctx, "Send a text note, photo, image file, or link. Every note starts in Inbox. Use /status or /retry. Photos and image files up to 5 MiB are supported. Add a caption if you want. Public links include page context when available.");
      return;
    }
    if (command === "status") {
      const status = options.log.status();
      await shortReply(ctx, "Captured: " + status.captured + ". Saved and confirmed: " + status.saved +
        ". Pending: " + status.pending + ". Need review: " + status.needsReview + ".");
      return;
    }
    if (command === "retry") {
      const count = options.processor.retryFailed();
      await shortReply(ctx, "Requeued " + count + " message(s). Uncertain writes will be reconciled before any new page.");
      options.kick();
      return;
    }
    const result = acceptText(ctx.update, options.allowedUserId, options.timezone, options.log);
    if (result.kind === "unsupported") {
      await shortReply(ctx, "Send text or a JPEG, PNG, GIF, or WebP image up to 5 MiB. Voice and other files are not supported.");
    } else if (result.kind === "accepted") {
      await shortReply(ctx, "Received locally. I will confirm when the note is saved in Notion.");
      options.kick();
    } else if (result.kind === "duplicate") {
      // Replayed Telegram updates never trigger another capture or provider write.
      options.kick();
    }
  });
}

export class TelegramNotifier implements Notifier {
  constructor(private bot: Bot) {}
  async saved(capture: Capture, entries: Entry[], pages: Map<number, SavedPage>): Promise<void> {
    const lines = entries.map((entry, index) => entry.category + ": " + entry.title + "\n" + pages.get(index)!.url);
    // One confirmation can hold up to 20 entries; chunk it without repeating Notion writes.
    const text = "Saved " + entries.length + " note(s) in Inbox.\n\n" + lines.join("\n\n");
    // Keep the confirmation in one message, even for a large capture.
    const reply = text.length <= 4000 ? text :
      "Saved " + entries.length + " notes in Inbox. Open Notion to review them.\n" + [...pages.values()].map((page) => page.url).join("\n");
    try { await this.bot.api.sendMessage(capture.chatId, reply, { link_preview_options: { is_disabled: true } }); }
    catch (error) {
      const retryAfter = error instanceof GrammyError ? error.parameters.retry_after : undefined;
      throw new ProviderError("telegram_confirmation_failed", {
        retryable: true, retryAfterMs: retryAfter ? retryAfter * 1000 : 0,
      });
    }
  }
  async pending(capture: Capture, code: string): Promise<void> {
    await this.bot.api.sendMessage(capture.chatId,
      "Your capture is preserved locally, but delivery is pending (" + code + "). Use /status or /retry.");
  }
}

// Use grammY for API calls and middleware, but own the offset explicitly.
// Built-in bot.stop() can confirm the last attempted update after a fatal storage failure.
export async function pollTelegram(bot: Bot, signal: AbortSignal): Promise<void> {
  await bot.init();
  let offset: number | undefined;
  let errors = 0;
  while (!signal.aborted) {
    let updates: Update[];
    try {
      // grammY declares its older AbortSignal shim; native Node signals implement the runtime API.
      const apiSignal = signal as unknown as NonNullable<Parameters<typeof bot.api.getUpdates>[1]>;
      updates = await bot.api.getUpdates({ offset, timeout: 20, allowed_updates: ["message"] }, apiSignal);
      errors = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof GrammyError && [401, 403, 409].includes(error.error_code)) {
        throw new ProviderError("telegram_poll_" + error.error_code);
      }
      if (++errors >= 5) throw new ProviderError("telegram_poll_unavailable");
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, Math.min(1000 * 2 ** errors, 15000));
        signal.addEventListener("abort", done, { once: true });
      });
      continue;
    }
    for (const update of updates) {
      if (signal.aborted) return;
      try { await bot.handleUpdate(update); }
      catch (error) { throw error instanceof BotError ? error.error : error; }
      // All accepted text is on disk at this point. A fatal handler error skips this update's acknowledgement.
      offset = update.update_id + 1;
    }
  }
}


// The token-bearing download URL stays inside this adapter and is never persisted or sent to the model.
export function telegramImageDownload(bot: Bot, token: string, request: typeof fetch = fetch): (fileId: string) => Promise<Response> {
  return async (fileId) => {
    try {
      const file = await bot.api.getFile(fileId);
      if (!file.file_path || !/^[a-zA-Z0-9_/.-]+$/.test(file.file_path) || file.file_path.includes("..")) {
        throw new ProviderError("telegram_image_path_invalid");
      }
      return await request("https://api.telegram.org/file/bot" + token + "/" + file.file_path,
        { signal: AbortSignal.timeout(25000), redirect: "error" });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const retryAfter = error instanceof GrammyError ? error.parameters.retry_after : undefined;
      throw new ProviderError("telegram_image_download_failed", {
        retryable: true, retryAfterMs: retryAfter ? retryAfter * 1000 : 0,
      });
    }
  };
}
