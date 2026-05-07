export type Defaults = {
  projectDir?: string;
  module?: string;
  bundleName?: string;
  abilityName?: string;
  deviceSn?: string;
  emulatorName?: string;
  buildMode?: "debug" | "release";
};

let state: Defaults = {};

export function getDefaults(): Defaults {
  return { ...state };
}

export function setDefaults(patch: Partial<Defaults>): Defaults {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "") {
      delete (state as Record<string, unknown>)[k];
    } else if (v !== undefined) {
      (state as Record<string, unknown>)[k] = v;
    }
  }
  return getDefaults();
}

export function clearDefaults(): void {
  state = {};
}
