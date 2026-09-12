/**
 * Reasoning effort, bridged from T3's model-options dropdown to pi's thinking
 * level.
 *
 * T3 does not invent this control — it builds it from the `configOptions` an
 * agent reports, and drives it back through `session/set_config_option`
 * (`CursorProvider.ts`: buildCursorCapabilitiesFromConfigOptions /
 * resolveCursorAcpConfigUpdates). Report no config options and the dropdown
 * does not appear at all, which is what the first cut of this bridge did.
 *
 * Two constraints shape what is exposed:
 *
 *  - T3's `normalizeCursorReasoningValue` only recognises low / medium / high /
 *    xhigh / max. pi also has "off" and "minimal", but T3 discards any value
 *    outside its list, so offering them would produce a dropdown entry that
 *    silently does nothing.
 *  - `findCursorEffortConfigOption` matches on `id === "effort"` before it
 *    looks at categories, so that id is the reliable handle. The category is
 *    set to ACP's canonical `thought_level` rather than Cursor's private
 *    `model_option`.
 */
import type { ThinkingLevel } from "./types.ts";

export const EFFORT_CONFIG_ID = "effort";
export const DEFAULT_EFFORT: ThinkingLevel = "medium";

/** The subset of pi's thinking levels T3 is able to round-trip. */
export const EFFORT_LEVELS = [
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
  { value: "xhigh", name: "Extra High" },
  { value: "max", name: "Max" },
] as const;

export interface SessionConfigOption {
  id: string;
  name: string;
  category: string;
  description: string;
  type: "select";
  currentValue: string;
  options: ReadonlyArray<{ value: string; name: string }>;
}

export function buildEffortConfigOption(current: string = DEFAULT_EFFORT): SessionConfigOption {
  return {
    id: EFFORT_CONFIG_ID,
    name: "Reasoning",
    category: "thought_level",
    description: "How much thinking pi does before answering.",
    type: "select",
    currentValue: normalizeEffort(current) ?? DEFAULT_EFFORT,
    options: [...EFFORT_LEVELS],
  };
}

/** Accepts T3's spellings of the extra-high level as well as pi's. */
export function normalizeEffort(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "xhigh";
    default:
      return undefined;
  }
}
