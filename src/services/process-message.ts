import { InboxLog, type MessageState } from "../storage/inbox-log.js";
import { ProviderError, StorageError } from "../errors.js";
import { extractionSchema, type Capture, type Entry, type SavedPage, type SourceContext, type ImageData, type ImageUpload, itemId } from "../schemas/note.js";

export interface Classifier { classify(capture: Capture, context?: SourceContext, image?: ImageData): Promise<Entry[]>; }
export interface ContentService {
  prepare(capture: Capture): Promise<SourceContext>;
  image(context?: SourceContext): ImageData | undefined;
}
export interface NoteStore {
  uploadImage?(image: ImageData): Promise<ImageUpload>;
  hasSource(sourceId: string): Promise<boolean>;
  find(itemId: string): Promise<SavedPage[]>;
  save(capture: Capture, entry: Entry, index: number, context?: SourceContext, upload?: ImageUpload): Promise<SavedPage>;
}
export interface Notifier {
  saved(capture: Capture, entries: Entry[], pages: Map<number, SavedPage>): Promise<void>;
  pending(capture: Capture, code: string): Promise<void>;
}

export class InboxProcessor {
  private running?: Promise<void>;
  private stopped = false;
  constructor(
    readonly log: InboxLog,
    private classifier: Classifier,
    private store: NoteStore,
    private notifier: Notifier,
    private options: { now?: () => number; maxAttempts?: number; retryBaseMs?: number; content?: ContentService } = {},
  ) {}

  drain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = undefined; });
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  retryFailed(): number {
    let count = 0;
    for (const state of this.log.messages()) {
      if (!state.confirmed && state.failure) {
        this.log.record({ type: "retry", sourceId: state.capture.sourceId, resetAttempts: true });
        count++;
      }
    }
    return count;
  }

  private async run(): Promise<void> {
    for (const state of this.log.messages()) {
      if (this.stopped || state.confirmed) continue;
      if (this.log.messages().some((message) => (message.providerPauseUntil ?? 0) > this.now())) return;
      if (state.failure) {
        if (!state.failure.retryAt || Date.parse(state.failure.retryAt) > this.now()) continue;
        this.log.record({ type: "retry", sourceId: state.capture.sourceId, resetAttempts: false });
      }
      await this.process(state);
    }
  }

  private async process(state: MessageState): Promise<void> {
    const capture = state.capture;
    let operation = "classify";
    try {
      if (!state.entries) {
        if (await this.store.hasSource(capture.sourceId)) {
          throw new ProviderError("extraction_missing_needs_review");
        }
        operation = "prepare";
        if (!state.context && this.options.content) {
          this.log.record({ type: "context", sourceId: capture.sourceId,
            context: await this.options.content.prepare(capture) });
        }
        if (capture.image && !state.context?.image) throw new ProviderError("image_context_missing");
        operation = "classify";
        const entries = extractionSchema.parse({ entries: await this.classifier.classify(capture, state.context,
          this.options.content?.image(state.context)) }).entries;
        this.log.record({ type: "extraction", sourceId: capture.sourceId, entries });
      }
      const entries = state.entries!;
      for (let index = 0; index < entries.length; index++) {
        operation = "notion:" + index;
        if (state.pages.has(index)) continue;
        // Query even without an intent: a restored backup may predate a confirmed page.
        const existing = await this.store.find(itemId(capture, index));
        if (existing.length > 1) throw new ProviderError("duplicate_item_needs_review");
        if (existing[0]) {
          this.log.record({ type: "saved", sourceId: capture.sourceId, index, page: existing[0] });
          continue;
        }
        if (state.intents.has(index)) throw new ProviderError("uncertain_write_needs_review");
        if (state.context?.image && (!state.upload || Date.parse(state.upload.expiresAt) <= this.now() + 60000)) {
          operation = "upload";
          const image = this.options.content?.image(state.context);
          if (!image || !this.store.uploadImage) throw new ProviderError("image_upload_unavailable");
          this.log.record({ type: "upload", sourceId: capture.sourceId, upload: await this.store.uploadImage(image) });
        }
        operation = "notion:" + index;
        this.log.record({ type: "intent", sourceId: capture.sourceId, index });
        let page: SavedPage;
        try { page = await this.store.save(capture, entries[index]!, index, state.context, state.upload); }
        catch (error) {
          if (error instanceof ProviderError && !error.ambiguous) {
            this.log.record({ type: "clear_intent", sourceId: capture.sourceId, index });
          }
          throw error;
        }
        this.log.record({ type: "saved", sourceId: capture.sourceId, index, page });
      }
      operation = "confirm";
      await this.notifier.saved(capture, entries, state.pages);
      this.log.record({ type: "confirmed", sourceId: capture.sourceId });
    } catch (error) {
      if (error instanceof StorageError) throw error;
      const failure = error instanceof ProviderError ? error :
        new ProviderError(operation === "classify" ? "classification_invalid" : "provider_unexpected",
          { retryable: operation === "classify" });
      const attempt = (state.attempts.get(operation) ?? 0) + 1;
      const retryable = failure.retryable && attempt < (this.options.maxAttempts ?? 3);
      const wait = Math.max(failure.retryAfterMs,
        (this.options.retryBaseMs ?? 2000) * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
      this.log.record({
        type: "failure", sourceId: capture.sourceId, operation, code: failure.code, attempt,
        retryAt: retryable ? new Date(this.now() + wait).toISOString() : null,
        ...(failure.retryAfterMs > 0 ? { providerPauseUntil: new Date(this.now() + failure.retryAfterMs).toISOString() } : {}),
      });
      // A failure notification is best effort; it never changes the durable delivery state.
      if (failure.retryAfterMs === 0) {
        try { await this.notifier.pending(capture, failure.code); } catch { /* /status remains available. */ }
      }
    }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
}

