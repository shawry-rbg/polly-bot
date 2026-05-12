import { PolymarketEvent } from "./polymarket";

export type TempUnit = "F" | "C";

export interface TempBucket {
  unit: TempUnit;
  /** Inclusive lower/upper temperature bounds in `unit`. Open-ended sides use ±999. */
  range: [number, number];
}

/**
 * Parse a Polymarket weather-bucket question into a unit + numeric range.
 * Supports the patterns Polymarket uses for daily-temperature markets:
 *   - "between 70-72°F"                  -> { F, [70, 72] }
 *   - "70°F or below" / "100°F or higher" -> { F, [-999, 70] } / { F, [100, 999] }
 *   - "17°C" (single-degree)              -> { C, [17, 17] }
 *   - "10°C or below" / "20°C or higher"  -> { C, [-999, 10] } / { C, [20, 999] }
 */
export function parseTempBucket(
  question: string | undefined | null
): TempBucket | null {
  if (!question) return null;
  const q = question.toLowerCase();

  if (q.includes("°f")) {
    let m = /(\d+)°f or below/i.exec(question);
    if (m) return { unit: "F", range: [-999, parseInt(m[1], 10)] };
    m = /(\d+)°f or higher/i.exec(question);
    if (m) return { unit: "F", range: [parseInt(m[1], 10), 999] };
    m = /between (\d+)-(\d+)°f/i.exec(question);
    if (m) return { unit: "F", range: [parseInt(m[1], 10), parseInt(m[2], 10)] };
    m = /(\d+)°f(?!\w)/i.exec(question);
    if (m) {
      const n = parseInt(m[1], 10);
      return { unit: "F", range: [n, n] };
    }
  }

  if (q.includes("°c")) {
    let m = /(\d+)°c or below/i.exec(question);
    if (m) return { unit: "C", range: [-999, parseInt(m[1], 10)] };
    m = /(\d+)°c or higher/i.exec(question);
    if (m) return { unit: "C", range: [parseInt(m[1], 10), 999] };
    m = /between (\d+)-(\d+)°c/i.exec(question);
    if (m) return { unit: "C", range: [parseInt(m[1], 10), parseInt(m[2], 10)] };
    m = /(\d+)°c(?!\w)/i.exec(question);
    if (m) {
      const n = parseInt(m[1], 10);
      return { unit: "C", range: [n, n] };
    }
  }

  return null;
}

/** Backwards-compatible helper that returns just the numeric range. */
export function parseTempRange(
  question: string | undefined | null
): [number, number] | null {
  const b = parseTempBucket(question);
  return b ? b.range : null;
}

export function hoursUntilResolution(event: PolymarketEvent): number {
  try {
    const endDate = (event as any).endDate ?? (event as any).end_date_iso;
    if (!endDate) return 999;
    const iso = String(endDate).replace("Z", "+00:00");
    const endDt = new Date(iso);
    const now = new Date();
    const deltaHours = (endDt.getTime() - now.getTime()) / (1000 * 3600);
    return Math.max(0, deltaHours);
  } catch {
    return 999;
  }
}
