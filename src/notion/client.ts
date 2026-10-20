import { Client, isNotionClientError } from "@notionhq/client";
import type { Capture, Entry, SavedPage, SourceContext, ImageData, ImageUpload } from "../schemas/note.js";
import { itemId } from "../schemas/note.js";
import type { NoteStore } from "../services/process-message.js";
import { ProviderError } from "../errors.js";
import { notionId } from "./ids.js";

export const NOTION_VERSION = "2026-03-11";
export const categories = ["Task", "Idea", "Knowledge", "Journal", "Reference"];
export const statuses = ["Inbox", "Open", "Done", "Archived"];
export const notionProperties = {
  Name: { title: {} },
  Category: { select: { options: categories.map((name) => ({ name })) } },
  Project: { rich_text: {} },
  Tags: { multi_select: {} },
  Status: { select: { options: statuses.map((name) => ({ name })) } },
  "Captured At": { date: {} },
  "Due Date": { date: {} },
  "Source ID": { rich_text: {} },
  "Item ID": { rich_text: {} },
};
const expectedTypes: Record<string, string> = {
  Name: "title", Category: "select", Project: "rich_text", Tags: "multi_select", Status: "select",
  "Captured At": "date", "Due Date": "date", "Source ID": "rich_text", "Item ID": "rich_text",
};

export function createNotionClient(token: string, request?: typeof fetch): Client {
  return new Client({
    auth: token, notionVersion: NOTION_VERSION, retry: false, timeoutMs: 20000,
    logger: () => {}, ...(request ? { fetch: request } : {}),
  });
}

export function notionError(error: unknown, write = false): ProviderError {
  if (error instanceof ProviderError) return error;
  if (isNotionClientError(error)) {
    const status = "status" in error && typeof error.status === "number" ? error.status : 0;
    const headers = "headers" in error && error.headers instanceof Headers ? error.headers : undefined;
    const retryAfter = Number(headers?.get("retry-after") || 0);
    return new ProviderError(status ? "notion_http_" + status : "notion_network_error", {
      retryable: status === 0 || status === 429 || status >= 500,
      ambiguous: write && (status === 0 || status >= 500 && status !== 529),
      retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 0,
    });
  }
  return new ProviderError("notion_network_error", { retryable: !write, ambiguous: write });
}

export function richText(text: string): { type: "text"; text: { content: string } }[] {
  const points = [...text];
  const chunks: { type: "text"; text: { content: string } }[] = [];
  // UTF-16 length stays below Notion's limit even for astral characters.
  let current = "";
  for (const point of points) {
    if (current.length + point.length > 1800) {
      chunks.push({ type: "text", text: { content: current } });
      current = "";
    }
    current += point;
  }
  if (current) chunks.push({ type: "text", text: { content: current } });
  return chunks;
}

export function pageParameters(dataSourceId: string, capture: Capture, entry: Entry, index: number, context?: SourceContext, upload?: ImageUpload):
  Parameters<Client["pages"]["create"]>[0] {
  return {
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties: {
      Name: { title: richText(entry.title) },
      Category: { select: { name: entry.category } },
      Project: { rich_text: richText(entry.project ?? "") },
      Tags: { multi_select: [...new Set(entry.tags)].map((name) => ({ name })) },
      Status: { select: { name: "Inbox" } },
      "Captured At": { date: { start: capture.capturedAt } },
      "Due Date": { date: entry.dueDate ? { start: entry.dueDate } : null },
      "Source ID": { rich_text: richText(capture.sourceId) },
      "Item ID": { rich_text: richText(itemId(capture, index)) },
    },
    children: [
      { object: "block", type: "heading_2", heading_2: { rich_text: richText("Extracted note") } },
      { object: "block", type: "paragraph", paragraph: { rich_text: richText(entry.content) } },
      ...(upload ? [{ object: "block" as const, type: "image" as const,
        image: { type: "file_upload" as const, file_upload: { id: upload.id }, caption: richText("Original Telegram image") } }] : []),
      ...(context?.links.flatMap((link): NonNullable<Parameters<Client["pages"]["create"]>[0]["children"]> => [
        { object: "block", type: "heading_2", heading_2: { rich_text: richText("Saved link: " + (link.title || link.status)) } },
        { object: "block", type: "paragraph", paragraph: { rich_text: richText(link.url) } },
        { object: "block", type: "paragraph", paragraph: { rich_text: richText(link.status === "fetched" ?
          "Fetched page excerpt (up to 12,000 characters):\n" + link.content : "Page context unavailable (" + link.status + ").") } },
      ]) ?? []),
      { object: "block", type: "heading_2", heading_2: { rich_text: richText("Original Telegram message") } },
      { object: "block", type: "paragraph", paragraph: { rich_text: richText(capture.text) } },
    ],
  };
}

export class NotionStore implements NoteStore {
  constructor(private client: Client, readonly dataSourceId: string, private databaseId?: string) {}

  async verify(): Promise<void> {
    try {
      const schema = await this.client.dataSources.retrieve({ data_source_id: this.dataSourceId });
      if (!("parent" in schema)) throw new ProviderError("notion_incomplete_schema");
      const parent = schema.parent as { database_id?: string };
      if (this.databaseId && notionId(parent.database_id ?? "") !== notionId(this.databaseId)) {
        throw new ProviderError("notion_destination_mismatch");
      }
      for (const [name, type] of Object.entries(expectedTypes)) {
        if (schema.properties[name]?.type !== type) throw new ProviderError("notion_schema_mismatch");
      }
      const category = schema.properties.Category;
      const status = schema.properties.Status;
      if (category?.type !== "select" || !categories.every((name) => category.select.options.some((option) => option.name === name)) ||
          status?.type !== "select" || !statuses.every((name) => status.select.options.some((option) => option.name === name))) {
        throw new ProviderError("notion_options_mismatch");
      }
    } catch (error) { throw notionError(error); }
  }

  async find(id: string): Promise<SavedPage[]> {
    try {
      const result = await this.client.dataSources.query({
        data_source_id: this.dataSourceId,
        filter: { property: "Item ID", rich_text: { equals: id } },
        page_size: 2,
      });
      const pages = result.results.map((page) => {
        if (!("url" in page)) throw new ProviderError("notion_incomplete_page");
        return { id: page.id, url: page.url };
      });
      if (result.has_more || pages.length > 1) throw new ProviderError("duplicate_item_needs_review");
      return pages;
    } catch (error) { throw notionError(error); }
  }

  async hasSource(sourceId: string): Promise<boolean> {
    try {
      const result = await this.client.dataSources.query({
        data_source_id: this.dataSourceId,
        filter: { property: "Source ID", rich_text: { equals: sourceId } },
        page_size: 1,
      });
      return result.results.length > 0;
    } catch (error) { throw notionError(error); }
  }

  async uploadImage(image: ImageData): Promise<ImageUpload> {
    try {
      const extension = image.mime.split("/")[1];
      const upload = await this.client.fileUploads.create({ mode: "single_part", filename: "telegram-image." + extension,
        content_type: image.mime });
      const sent = await this.client.fileUploads.send({ file_upload_id: upload.id,
        file: { data: new Blob([new Uint8Array(image.bytes)], { type: image.mime }), filename: "telegram-image." + extension } });
      if (sent.status !== "uploaded") throw new ProviderError("notion_image_upload_incomplete", { retryable: true });
      return { id: sent.id, expiresAt: sent.expiry_time ?? new Date(Date.now() + 50 * 60 * 1000).toISOString() };
    } catch (error) { throw notionError(error); }
  }

  async save(capture: Capture, entry: Entry, index: number, context?: SourceContext, upload?: ImageUpload): Promise<SavedPage> {
    try {
      const page = await this.client.pages.create(pageParameters(this.dataSourceId, capture, entry, index, context, upload));
      if (!("url" in page)) throw new ProviderError("notion_incomplete_create", { ambiguous: true });
      return { id: page.id, url: page.url };
    } catch (error) { throw notionError(error, true); }
  }
}

