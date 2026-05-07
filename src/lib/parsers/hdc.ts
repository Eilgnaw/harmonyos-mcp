export type HdcDevice = {
  serial: string;
  state?: string;
  type?: string;
  rest?: string;
};

export function parseHdcList(stdout: string): HdcDevice[] {
  const text = stdout.trim();
  if (!text || text === "[Empty]") return [];
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      return {
        serial: parts[0],
        state: parts[1],
        type: parts[2],
        rest: parts.slice(3).join(" ") || undefined,
      };
    });
}

export function summarizeDevices(devices: HdcDevice[]): string {
  if (devices.length === 0) return "No devices connected (hdc list targets is empty).";
  return devices.map((d) => `${d.serial}${d.state ? `\t${d.state}` : ""}${d.type ? `\t${d.type}` : ""}`).join("\n");
}
