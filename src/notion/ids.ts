export function notionId(value: string): string {
  const compact = value.replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compact)) return value;
  return [compact.slice(0, 8), compact.slice(8, 12), compact.slice(12, 16),
    compact.slice(16, 20), compact.slice(20)].join("-");
}
