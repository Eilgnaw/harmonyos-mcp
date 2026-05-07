export type EmulatorInstance = {
  name: string;
  deviceType?: string;
  productModel?: string;
  osVersion?: string;
  apiVersion?: string;
  isRunning?: boolean;
  uuid?: string;
  raw: Record<string, unknown>;
};

export function parseEmulatorList(jsonText: string): EmulatorInstance[] {
  const arr = JSON.parse(jsonText) as Record<string, unknown>[];
  return arr.map((row) => ({
    name: String(row.name ?? ""),
    deviceType: row.deviceType as string | undefined,
    productModel: row.productModel as string | undefined,
    osVersion: row["os.osVersion"] as string | undefined,
    apiVersion: row["os.apiVersion"] as string | undefined,
    isRunning: row.isRunning === "true" || row.isRunning === true,
    uuid: row.uuid as string | undefined,
    raw: row,
  }));
}

export function summarizeEmulators(items: EmulatorInstance[]): string {
  if (items.length === 0) return "No emulator instances found.";
  const lines = ["name                 type     osVersion              api  running"];
  for (const e of items) {
    const name = e.name.padEnd(20).slice(0, 20);
    const type = (e.deviceType ?? "").padEnd(8).slice(0, 8);
    const os = (e.osVersion ?? "").padEnd(22).slice(0, 22);
    const api = (e.apiVersion ?? "").padEnd(4).slice(0, 4);
    const running = e.isRunning ? "yes" : "no";
    lines.push(`${name} ${type} ${os} ${api} ${running}`);
  }
  return lines.join("\n");
}
