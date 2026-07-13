import { Decimal } from 'decimal.js';

/**
 * Leaderboard scoring, ported from repStats()/rating() in vfw-console.html
 * (line 1120). Pure, so it can be tested against the mockup as the oracle.
 *
 * Read the inputs below and note what is NOT there: internal department comments
 * and designer feedback. Both are coaching inputs. They are deliberately absent
 * from this signature, so they cannot reach a score, a rank or a commission even
 * by accident — a caller has nowhere to put them. The UI says this out loud and
 * the ranking has to be able to back it up.
 */
export interface ScoreWeights {
  revenue: number;
  approved: number;
  collection: number;
  retention: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  revenue: 30,
  approved: 20,
  collection: 30,
  retention: 20,
};

/** Everything the score is allowed to know about a rep. All money in CAD. */
export interface RepStats {
  /** Net revenue (taxable, never tax) on approved + exported deals. */
  revenue: Decimal.Value;
  /** Gross invoiced on those same deals. */
  invoiced: Decimal.Value;
  /** Cash actually collected against them. */
  collected: Decimal.Value;
  /** Deals that reached a decision: approved, exported or rejected. */
  decidedCount: number;
  /** Of those, the ones that were approved or exported. */
  approvedCount: number;
  /** Distinct customers the rep has submitted for. */
  customerCount: number;
  /** Of those, the ones that came back for a second booking. */
  repeatCount: number;
  /** The rep's revenue target, in CAD. */
  target: Decimal.Value;
}

export interface ScoreParts {
  revenue: number;
  approved: number;
  collection: number;
  retention: number;
}

export interface Rating {
  stars: number;
  label: string;
  /** Reuses a status pill class from console.css, as the mockup does. */
  cls: string;
}

/** Each part is a ratio in [0, 1]; a rep cannot bank more than 100% of a weight. */
const ratio = (num: Decimal.Value, den: Decimal.Value): number => {
  const d = new Decimal(den);
  if (d.lte(0)) return 0;
  return Decimal.min(1, new Decimal(num).dividedBy(d)).toNumber();
};

export function scoreParts(stats: RepStats): ScoreParts {
  return {
    revenue: ratio(stats.revenue, stats.target),
    approved: stats.decidedCount ? stats.approvedCount / stats.decidedCount : 0,
    collection: ratio(stats.collected, stats.invoiced),
    retention: stats.customerCount ? Math.min(1, stats.repeatCount / stats.customerCount) : 0,
  };
}

export function score(stats: RepStats, weights: ScoreWeights): number {
  const p = scoreParts(stats);
  return Math.round(
    p.revenue * weights.revenue +
      p.approved * weights.approved +
      p.collection * weights.collection +
      p.retention * weights.retention,
  );
}

export function rating(sc: number): Rating {
  if (sc >= 95) return { stars: 5, label: 'Elite Performer', cls: 'APPROVED' };
  if (sc >= 90) return { stars: 5, label: 'Outstanding', cls: 'APPROVED' };
  if (sc >= 80) return { stars: 4, label: 'High Performer', cls: 'EXPORTED' };
  if (sc >= 70) return { stars: 3, label: 'Meets Expectations', cls: 'DRAFT' };
  if (sc >= 60) return { stars: 2, label: 'Needs Improvement', cls: 'PENDING' };
  return { stars: 1, label: 'Performance Review Required', cls: 'REJECTED' };
}

/** Parse Settings.scoreWeights, which is JSON and therefore not type-checked. */
export function parseWeights(raw: unknown): ScoreWeights {
  const w = (raw ?? {}) as Partial<Record<keyof ScoreWeights, unknown>>;
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    revenue: num(w.revenue, DEFAULT_WEIGHTS.revenue),
    approved: num(w.approved, DEFAULT_WEIGHTS.approved),
    collection: num(w.collection, DEFAULT_WEIGHTS.collection),
    retention: num(w.retention, DEFAULT_WEIGHTS.retention),
  };
}
