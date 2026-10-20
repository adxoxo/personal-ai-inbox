import "dotenv/config";
import { existsSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Client } from "@notionhq/client";
import { dataDirectory } from "../config.js";
import { InboxLog } from "../storage/inbox-log.js";
import { createNotionClient, notionProperties, NotionStore, notionError } from "./client.js";
import { ProviderError, StorageError, safeCode } from "../errors.js";
import { notionId } from "./ids.js";

function writePrivateJson(path: string, value: unknown): void {
  const temporary = path + "." + randomUUID() + ".tmp";
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  const dirFd = openSync(resolve(path, ".."), "r");
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

async function discoverDatabase(client: Client, parentId: string): Promise<string | undefined> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const children = await client.blocks.children.list({ block_id: parentId, start_cursor: cursor });
    for (const block of children.results) {
      if ("type" in block && block.type === "child_database" && block.child_database.title === "Personal Inbox") ids.push(block.id);
    }
    if (children.has_more && !children.next_cursor) throw new ProviderError("notion_invalid_pagination");
    cursor = children.has_more ? children.next_cursor ?? undefined : undefined;
  } while (cursor);
  if (ids.length > 1) throw new ProviderError("multiple_inbox_databases_choose_one");
  return ids[0];
}

export async function setupNotion(
  client: Client, parentId: string, directory: string,
  supplied: { databaseId?: string; dataSourceId?: string } = {},
): Promise<{ databaseId: string; dataSourceId: string }> {
  parentId = notionId(parentId);
  supplied = {
    databaseId: supplied.databaseId ? notionId(supplied.databaseId) : undefined,
    dataSourceId: supplied.dataSourceId ? notionId(supplied.dataSourceId) : undefined,
  };
  const setupPath = join(directory, "notion-setup.json");
  const intentPath = join(directory, "notion-setup-intent.json");
  const previous = existsSync(setupPath) ?
    JSON.parse(readFileSync(setupPath, "utf8")) as { databaseId: string; dataSourceId: string; parentId: string } : undefined;
  if ((previous && notionId(previous.parentId) !== parentId) ||
      (previous && supplied.databaseId && notionId(previous.databaseId) !== supplied.databaseId) ||
      (previous && supplied.dataSourceId && notionId(previous.dataSourceId) !== supplied.dataSourceId)) {
    throw new ProviderError("notion_destination_mismatch");
  }
  let databaseId = supplied.databaseId || previous?.databaseId;
  databaseId ||= await discoverDatabase(client, parentId);
  if (!databaseId) {
    if (existsSync(intentPath)) throw new ProviderError("notion_setup_uncertain_check_parent_page");
    writePrivateJson(intentPath, { parentId, createdAt: new Date().toISOString() });
    const database = await client.databases.create({
      parent: { type: "page_id", page_id: parentId },
      title: [{ type: "text", text: { content: "Personal Inbox" } }],
      initial_data_source: { properties: notionProperties },
    });
    databaseId = database.id;
  }
  const database = await client.databases.retrieve({ database_id: databaseId });
  if (!("data_sources" in database) || !("parent" in database) ||
      database.parent.type !== "page_id" || notionId(database.parent.page_id) !== parentId) {
    throw new ProviderError("notion_database_parent_mismatch");
  }
  const sources = database.data_sources;
  const dataSourceId = supplied.dataSourceId || previous?.dataSourceId || (sources.length === 1 ? sources[0]!.id : undefined);
  if (!dataSourceId || !sources.some((source) => notionId(source.id) === notionId(dataSourceId))) {
    throw new ProviderError("notion_choose_data_source");
  }
  await new NotionStore(client, dataSourceId, databaseId).verify();
  writePrivateJson(setupPath, { parentId, databaseId, dataSourceId });
  if (existsSync(intentPath)) unlinkSync(intentPath);
  return { databaseId, dataSourceId };
}

async function main(): Promise<void> {
  const token = process.env.NOTION_TOKEN?.trim();
  const parentId = process.env.NOTION_PARENT_PAGE_ID?.trim();
  if (!token || !parentId) throw new ProviderError("notion_token_and_parent_required");
  const directory = dataDirectory();
  const log = new InboxLog(directory);
  try {
    const ids = await setupNotion(createNotionClient(token), parentId, directory, {
      databaseId: process.env.NOTION_DATABASE_ID || undefined,
      dataSourceId: process.env.NOTION_DATA_SOURCE_ID || undefined,
    });
    console.log("Notion setup complete. Destination IDs are saved privately in data/notion-setup.json.");
    console.log("Database ID: " + ids.databaseId);
    console.log("Data source ID: " + ids.dataSourceId);
  } finally { log.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error("Notion setup stopped: " + safeCode(error instanceof StorageError ? error : notionError(error, true)));
    process.exitCode = 1;
  });
}

