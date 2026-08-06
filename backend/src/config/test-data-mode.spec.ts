import { ConfigService } from './config.service';
import { CONFIG_GROUPS, FIELD_BY_KEY } from './config.registry';

/**
 * The Test data switch, read the way every write path reads it.
 *
 * No database and no Nest: ConfigService resolves DB -> env -> undefined, and
 * with an empty cache the env half is the whole of it — which is exactly the
 * layer worth pinning, because the consequence of getting it wrong is either a
 * real sale entered as a rehearsal or a rehearsal entered as real.
 *
 * The value is a string on a `select` field, so the interesting cases are all
 * the ways a string can fail to be the word "on".
 */

/** A service with no DB rows cached — env is then the only source. */
function service(): ConfigService {
  const prisma = { configSetting: { findMany: () => Promise.resolve([]) } };
  return new ConfigService(prisma as never, {} as never);
}

describe('ConfigService.testDataMode', () => {
  const original = process.env.TEST_DATA_MODE;

  afterEach(() => {
    if (original === undefined) delete process.env.TEST_DATA_MODE;
    else process.env.TEST_DATA_MODE = original;
  });

  it('is off when nothing is set', () => {
    delete process.env.TEST_DATA_MODE;
    expect(service().testDataMode).toBe(false);
  });

  it('is on for the word the registry offers', () => {
    process.env.TEST_DATA_MODE = 'on';
    expect(service().testDataMode).toBe(true);
  });

  it('does not care about case or stray whitespace', () => {
    for (const v of ['ON', 'On', ' on ', '\ton\n']) {
      process.env.TEST_DATA_MODE = v;
      expect(service().testDataMode).toBe(true);
    }
  });

  it('treats the explicit off as off', () => {
    process.env.TEST_DATA_MODE = 'off';
    expect(service().testDataMode).toBe(false);
  });

  it('fails towards real data for anything it does not understand', () => {
    // The direction matters more than the parsing. A typo must not be able to
    // stamp the whole book as a rehearsal — 'true', '1' and 'yes' are all
    // things somebody will eventually type, and none of them are the switch.
    for (const v of ['true', '1', 'yes', 'enabled', 'no', '']) {
      process.env.TEST_DATA_MODE = v;
      expect(service().testDataMode).toBe(false);
    }
  });
});

describe('the Test data registry entry', () => {
  it('is editable from the Configuration screen', () => {
    // The switch is only useful if it is reachable without a developer, and the
    // screen renders entirely from this registry — a field missing here is a
    // field that does not exist as far as an admin is concerned.
    expect(FIELD_BY_KEY.has('TEST_DATA_MODE')).toBe(true);
  });

  it('offers exactly the two words the resolver understands', () => {
    // If these ever disagree, the screen offers a value that silently means off.
    expect(FIELD_BY_KEY.get('TEST_DATA_MODE')?.options).toEqual(['off', 'on']);
  });

  it('is not a secret, so its value is shown back to the admin', () => {
    // A write-only switch would render as "set / not set" with no way to see
    // which way it is pointing — useless for the one question it answers.
    expect(FIELD_BY_KEY.get('TEST_DATA_MODE')?.type).toBe('select');
  });

  it('requires nothing, so the group draws no configured/not-configured pill', () => {
    // "Off" is a legitimate answer; a permanently red pill would be noise.
    expect(CONFIG_GROUPS.find((g) => g.id === 'data')?.requiredKeys).toEqual([]);
  });
});
