import {
  DEFAULT_WEIGHTS,
  RepStats,
  parseWeights,
  rating,
  score,
  scoreParts,
} from './score';

/**
 * The oracle for these numbers is repStats()/rating() in vfw-console.html
 * (line 1120), which is the behaviour the business already agreed to.
 */

/** A rep who did everything perfectly: on target, never rejected, fully paid. */
const perfect: RepStats = {
  revenue: 500_000,
  invoiced: 560_000,
  collected: 560_000,
  decidedCount: 10,
  approvedCount: 10,
  customerCount: 4,
  repeatCount: 4,
  target: 500_000,
  };

const nobody: RepStats = {
  revenue: 0,
  invoiced: 0,
  collected: 0,
  decidedCount: 0,
  approvedCount: 0,
  customerCount: 0,
  repeatCount: 0,
  target: 0,
};

describe('leaderboard score', () => {
  it('awards the full 100 when every part is maxed', () => {
    expect(score(perfect, DEFAULT_WEIGHTS)).toBe(100);
  });

  it('scores a rep with no history at zero rather than dividing by zero', () => {
    expect(score(nobody, DEFAULT_WEIGHTS)).toBe(0);
    expect(scoreParts(nobody)).toEqual({
      revenue: 0,
      approved: 0,
      collection: 0,
      retention: 0,
    });
  });

  it('weights each part exactly as Settings says', () => {
    // Half the target, half the deals approved, half collected, half returning.
    const half: RepStats = {
      revenue: 250_000,
      invoiced: 100_000,
      collected: 50_000,
      decidedCount: 10,
      approvedCount: 5,
      customerCount: 4,
      repeatCount: 2,
      target: 500_000,
    };
    expect(scoreParts(half)).toEqual({
      revenue: 0.5,
      approved: 0.5,
      collection: 0.5,
      retention: 0.5,
    });
    // 0.5 * (30 + 20 + 30 + 20)
    expect(score(half, DEFAULT_WEIGHTS)).toBe(50);
  });

  it('clamps each part at 100% — beating target twice over does not bank 60 points', () => {
    const overachiever: RepStats = { ...perfect, revenue: 2_000_000, target: 500_000 };
    expect(scoreParts(overachiever).revenue).toBe(1);
    expect(score(overachiever, DEFAULT_WEIGHTS)).toBe(100);
  });

  it('gives no revenue credit to a rep with no target set', () => {
    const untargeted: RepStats = { ...perfect, target: 0 };
    expect(scoreParts(untargeted).revenue).toBe(0);
    // Loses the 30 revenue points, keeps the other 70.
    expect(score(untargeted, DEFAULT_WEIGHTS)).toBe(70);
  });

  it('reads money as Decimal strings without losing a cent to a float', () => {
    const s: RepStats = {
      ...nobody,
      revenue: '0.10',
      target: '0.30',
      invoiced: '0.30',
      collected: '0.10',
    };
    // 0.1/0.3 in binary floating point is 0.33333333333333337; as Decimal it is
    // 0.333… and the two parts stay equal to each other.
    expect(scoreParts(s).revenue).toBeCloseTo(1 / 3, 10);
    expect(scoreParts(s).collection).toEqual(scoreParts(s).revenue);
  });

  it('honours weights that Accounting has changed in Settings', () => {
    const allOnCollection = { revenue: 0, approved: 0, collection: 100, retention: 0 };
    const collectorOnly: RepStats = { ...nobody, invoiced: 1000, collected: 1000 };
    expect(score(collectorOnly, allOnCollection)).toBe(100);
    expect(score(collectorOnly, DEFAULT_WEIGHTS)).toBe(30);
  });

  it('falls back to the documented weights when Settings holds junk', () => {
    expect(parseWeights(null)).toEqual(DEFAULT_WEIGHTS);
    expect(parseWeights({ revenue: 'lots' })).toEqual(DEFAULT_WEIGHTS);
    expect(parseWeights({ revenue: 40, approved: 10, collection: 30, retention: 20 })).toEqual({
      revenue: 40, approved: 10, collection: 30, retention: 20,
    });
  });
});

/**
 * The promise the leaderboard UI makes out loud: internal department comments
 * and designer feedback are coaching inputs. They never touch the score, the
 * ranking or anyone's commission.
 *
 * The type system already enforces this — RepStats has nowhere to put them — so
 * these tests attack it at runtime, the way a careless future change would: by
 * smuggling the fields in anyway and checking that nothing moves.
 */
describe('coaching inputs cannot reach the score', () => {
  it('ignores a scathing internal comment and a one-star review entirely', () => {
    const clean = score(perfect, DEFAULT_WEIGHTS);

    const smuggled = {
      ...perfect,
      internalComments: [{ department: 'Operations', body: 'Repeatedly misses deadlines.' }],
      internalCommentCount: 12,
      designerFeedback: [{ rating: 1, body: 'Would not work with this rep again.' }],
      feedbackRating: 1,
      averageStars: 1,
    } as RepStats;

    expect(score(smuggled, DEFAULT_WEIGHTS)).toBe(clean);
    expect(scoreParts(smuggled)).toEqual(scoreParts(perfect));
    expect(rating(score(smuggled, DEFAULT_WEIGHTS))).toEqual(rating(clean));
  });

  it('is a function of exactly the four commercial inputs and nothing else', () => {
    // If someone adds a fifth input to the score, this list is the thing they
    // have to change on purpose — it cannot happen by accident.
    expect(Object.keys(scoreParts(perfect)).sort()).toEqual([
      'approved',
      'collection',
      'retention',
      'revenue',
    ]);
  });
});

describe('rating bands', () => {
  it.each([
    [100, 'Elite Performer'],
    [95, 'Elite Performer'],
    [94, 'Outstanding'],
    [90, 'Outstanding'],
    [89, 'High Performer'],
    [80, 'High Performer'],
    [79, 'Meets Expectations'],
    [70, 'Meets Expectations'],
    [69, 'Needs Improvement'],
    [60, 'Needs Improvement'],
    [59, 'Performance Review Required'],
    [0, 'Performance Review Required'],
  ])('scores %i as "%s"', (sc, label) => {
    expect(rating(sc).label).toBe(label);
  });
});
