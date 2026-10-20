import "dotenv/config";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { timezoneSchema } from "./schemas/note.js";
import { ProviderError } from "./errors.js";
import { notionId } from "./notion/ids.js";

export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.DATA_DIR || "./data");
}
export function notionIds(directory: string, env: NodeJS.ProcessEnv = process.env): { databaseId: string; dataSourceId: string } {
  const path = resolve(directory, "notion-setup.json");
  const saved: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const parsed = z.object({ databaseId: z.string().optional(), dataSourceId: z.string().optional() }).parse(saved);
  const databaseId = env.NOTION_DATABASE_ID || parsed.databaseId;
  const dataSourceId = env.NOTION_DATA_SOURCE_ID || parsed.dataSourceId;
  if (!databaseId || !dataSourceId) throw new ProviderError("notion_setup_required");
  if ((env.NOTION_DATABASE_ID && parsed.databaseId && notionId(env.NOTION_DATABASE_ID) !== notionId(parsed.databaseId)) ||
      (env.NOTION_DATA_SOURCE_ID && parsed.dataSourceId && notionId(env.NOTION_DATA_SOURCE_ID) !== notionId(parsed.dataSourceId))) {
    throw new ProviderError("notion_destination_mismatch");
  }
  return { databaseId: notionId(databaseId), dataSourceId: notionId(dataSourceId) };
}
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ProviderError("config_missing_" + name.toLowerCase());
  return value;
}
export function runtimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = dataDirectory(env);
  const timezone = required(env, "USER_TIMEZONE");
  if (!timezoneSchema.safeParse(timezone).success) throw new ProviderError("config_invalid_timezone");
  const allowedUserId = required(env, "ALLOWED_TELEGRAM_USER_ID");
  if (!/^\d+$/.test(allowedUserId)) throw new ProviderError("config_invalid_telegram_user");
  return {
    dataDir, timezone, allowedUserId,
    botToken: required(env, "TELEGRAM_BOT_TOKEN"),
    deepseekKey: required(env, "DEEPSEEK_API_KEY"),
    deepseekModel: env.DEEPSEEK_MODEL?.trim() || "deepseek-flash",
    notionToken: required(env, "NOTION_TOKEN"),
    ...notionIds(dataDir, env),
  };
}

