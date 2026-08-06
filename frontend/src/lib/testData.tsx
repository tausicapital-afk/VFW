import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Highlighting test data.
 *
 * Demo and rehearsal records live in the same database as the real book (see
 * backend/prisma/schema.prisma, Submission.isTestData). Every module table draws
 * them next to real ones, and until this existed there was nothing on screen
 * that told the two apart — which is how a demo sale ends up inside a figure
 * somebody reconciles against.
 *
 * The whole of the marking lives here, in three pieces, so that no screen has to
 * decide what "marked" looks like:
 *
 *   useTestRow()  -> the row class, or nothing
 *   <TestTag />   -> the pill that sits next to the reference
 *   <TestDataProvider> + Settings -> whether either of them does anything
 *
 * Both readers go through the same preference, so the Settings switch turns the
 * feature off everywhere at once rather than per screen. The colours are CSS
 * tokens (--test-*, defined for both themes in styles/additions.css); nothing in
 * this file knows a hex value.
 *
 * It is a `.tsx` in lib/ rather than a component in shell/ because the component
 * is the small half: splitting the pill from the hook that decides whether to
 * draw it would put one rule in two files.
 */

/** Any API row carrying the flag. Optional, so a payload without it is simply not marked. */
export interface TestFlagged {
  isTestData?: boolean | null;
}

// Kept in the same shape as the theme preference (see theme/ThemeContext.tsx):
// a single localStorage key holding a word, read once at mount.
const KEY = 'vfw-test-highlight';

/**
 * Defaults ON.
 *
 * The failure this feature prevents is silent — a demo row read as real — and
 * defaulting off would mean nobody sees the marking until they go looking for a
 * setting they do not know exists. Turning it off is a deliberate act by
 * somebody who already knows what the tint means.
 */
function readPref(): boolean {
  return localStorage.getItem(KEY) !== 'off';
}

interface TestHighlightValue {
  on: boolean;
  setOn: (v: boolean) => void;
}

const Ctx = createContext<TestHighlightValue | null>(null);

export function TestDataProvider({ children }: { children: ReactNode }) {
  const [on, setOnState] = useState<boolean>(readPref);

  useEffect(() => {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  }, [on]);

  return <Ctx.Provider value={{ on, setOn: setOnState }}>{children}</Ctx.Provider>;
}

/**
 * The preference itself. Settings owns the switch; nothing else should need this
 * — a table wants useTestRow/TestTag, which already consult it.
 */
export function useTestHighlight(): TestHighlightValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTestHighlight must be used inside <TestDataProvider>');
  return v;
}

/**
 * The class for a table row, given the row.
 *
 * Returns `undefined` rather than an empty string when there is nothing to add,
 * so `className={testRow(s)}` leaves the attribute off entirely instead of
 * emitting `class=""`. Extra classes may be passed through, because plenty of
 * rows already carry one:
 *
 *   <tr className={testRow(s)}>
 *   <tr className={testRow(e, 'email-row', selected && 'on')}>
 *
 * Taking the row (not a boolean) is deliberate: the call site then cannot get
 * the field name wrong on one screen and right on another, which is exactly how
 * a marking that is meant to be universal ends up missing from one table.
 */
export function useTestRow() {
  const { on } = useTestHighlight();
  return (
    row: TestFlagged | boolean | null | undefined,
    ...extra: (string | false | null | undefined)[]
  ): string | undefined => {
    const flagged = typeof row === 'boolean' ? row : Boolean(row?.isTestData);
    const classes = extra.filter(Boolean) as string[];
    if (on && flagged) classes.push('is-test');
    return classes.length ? classes.join(' ') : undefined;
  };
}

/**
 * The marker itself — a pill, next to whatever identifies the row (the ref, the
 * brand, the person).
 *
 * The tint alone is not enough and never was: it is a wash a few percent off the
 * card by design, it disappears in a screenshot pasted into a chat, and it is
 * invisible to anyone who cannot separate those two colours. The word TEST is
 * the part that actually carries the meaning; the tint is what makes a whole
 * block of them findable by scanning.
 */
export function TestTag({ on }: { on?: boolean | null }) {
  const { on: enabled } = useTestHighlight();
  if (!enabled || !on) return null;
  return (
    <span className="pill testdata" title="This record is test/demo data, not a real record">
      Test
    </span>
  );
}
