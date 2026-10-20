import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  unlinkSync, writeFileSync, chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { envelopeSchema, type Capture, type Entry, type Failure, type InboxEvent, type SavedPage, type SourceContext, type ImageUpload } from "../schemas/note.js";
import { StorageError } from "../errors.js";

export type MessageState = {
  capture: Capture;
  entries?: Entry[];
  context?: SourceContext;
  upload?: ImageUpload;
  intents: Set<number>;
  pages: Map<number, SavedPage>;
  attempts: Map<string, number>;
  failure?: Failure;
  confirmed: boolean;
  providerPauseUntil?: number;
};

export class InboxLog {
  readonly directory: string;
  private readonly lockPath: string;
  private readonly owner = randomUUID();
  private fd = -1;
  private closed = false;
  private poisoned = false;
  private states = new Map<string, MessageState>();

  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.lockPath = join(this.directory, "process.lock");
    let lockFd: number;
    try { lockFd = openSync(this.lockPath, "wx", 0o600); }
    catch { throw new StorageError("process_lock_exists"); }
    try {
      writeFileSync(lockFd, JSON.stringify({ owner: this.owner, pid: process.pid, host: hostname() }));
      fsyncSync(lockFd);
    } finally { closeSync(lockFd); }
    try {
      const path = join(this.directory, "inbox.jsonl");
      if (existsSync(path)) {
        const content = readFileSync(path, "utf8");
        if (content.length > 0 && !content.endsWith("\n")) throw new StorageError("journal_incomplete_record");
        for (const line of content.split("\n").slice(0, -1)) {
          this.apply(envelopeSchema.parse(JSON.parse(line)).event);
        }
      }
      this.fd = openSync(path, "a", 0o600);
      chmodSync(path, 0o600);
      // Persist the directory entry for newly created journal and lock files.
      const dirFd = openSync(this.directory, "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch (error) {
      this.releaseLock();
      throw error instanceof StorageError ? error : new StorageError("journal_invalid");
    }
  }

  get(sourceId: string): MessageState | undefined { return this.states.get(sourceId); }
  messages(): MessageState[] { return [...this.states.values()]; }
  status(): { captured: number; saved: number; pending: number; needsReview: number } {
    const all = this.messages();
    return {
      captured: all.length,
      saved: all.filter((state) => state.confirmed).length,
      pending: all.filter((state) => !state.confirmed).length,
      needsReview: all.filter((state) => state.failure?.retryAt === null).length,
    };
  }

  record(input: InboxEvent): void {
    if (this.closed || this.poisoned) throw new StorageError("journal_unavailable");
    const envelope = envelopeSchema.parse({ version: 1, recordedAt: new Date().toISOString(), event: input });
    // Validate transitions before a durable append.
    this.validateTransition(envelope.event);
    try {
      writeFileSync(this.fd, JSON.stringify(envelope) + "\n");
      fsyncSync(this.fd);
    } catch {
      this.poisoned = true;
      throw new StorageError("journal_write_failed");
    }
    this.apply(envelope.event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.fd >= 0) closeSync(this.fd);
    this.releaseLock();
  }

  private releaseLock(): void {
    try {
      const lock = JSON.parse(readFileSync(this.lockPath, "utf8")) as { owner?: string };
      if (lock.owner === this.owner) unlinkSync(this.lockPath);
    } catch { /* Preserve a lock that cannot be identified as ours. */ }
  }

  private validateTransition(event: InboxEvent): void {
    if (event.type === "capture") {
      if (this.states.has(event.capture.sourceId)) throw new StorageError("capture_already_exists");
      return;
    }
    const state = this.states.get(event.sourceId);
    if (!state) throw new StorageError("journal_missing_capture");
    if (event.type === "context" && state.context) throw new StorageError("context_already_exists");
    if (event.type === "extraction" && state.entries) throw new StorageError("extraction_already_exists");
    if ("index" in event && (!state.entries || !state.entries[event.index])) {
      throw new StorageError("journal_missing_item");
    }
    if (event.type === "confirmed" && (!state.entries || state.pages.size !== state.entries.length)) {
      throw new StorageError("journal_incomplete_delivery");
    }
  }

  private apply(event: InboxEvent): void {
    this.validateTransition(event);
    if (event.type === "capture") {
      this.states.set(event.capture.sourceId, {
        capture: event.capture, intents: new Set(), pages: new Map(),
        attempts: new Map(), confirmed: false,
      });
      return;
    }
    const state = this.states.get(event.sourceId)!;
    switch (event.type) {
      case "context": state.context = event.context; break;
      case "upload": state.upload = event.upload; break;
      case "extraction": state.entries = event.entries; break;
      case "intent": state.intents.add(event.index); break;
      case "clear_intent": state.intents.delete(event.index); break;
      case "saved": state.pages.set(event.index, event.page); state.intents.delete(event.index); break;
      case "failure":
        state.failure = event;
        if (event.providerPauseUntil) state.providerPauseUntil = Date.parse(event.providerPauseUntil);
        state.attempts.set(event.operation, event.attempt);
        break;
      case "retry":
        state.failure = undefined;
        if (event.resetAttempts) state.attempts.clear();
        break;
      case "confirmed": state.confirmed = true; state.failure = undefined; break;
    }
  }
}

export function recoverLock(directory: string): void {
  const path = join(resolve(directory), "process.lock");
  const text = readFileSync(path, "utf8");
  const lock = JSON.parse(text) as { pid: number; host: string; owner: string };
  if (lock.host !== hostname() || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || !lock.owner) {
    throw new StorageError("lock_owner_unverifiable");
  }
  try {
    process.kill(lock.pid, 0);
    throw new StorageError("lock_owner_alive");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
  if (readFileSync(path, "utf8") !== text) throw new StorageError("lock_owner_changed");
  unlinkSync(path);
}

