import { StorageService } from '../storage/storage.service';

/**
 * Avatars live in R2 alongside submission documents, and are read the same way:
 * a presigned GET, never a proxy through this API.
 *
 * They are, however, read very differently from a contract. A contract is
 * downloaded once, by someone who just clicked a button. An avatar is an <img>
 * in the sidebar of a page that may sit open for an entire shift — so the link
 * is signed for an hour rather than five minutes, and the client re-fetches the
 * profile well inside that window. Nothing is weakened by the longer window: the
 * URL still grants exactly one object, still expires, and still cannot be minted
 * without the bucket credentials.
 */
export const AVATAR_URL_TTL_SECONDS = 60 * 60;

/** Every key this system will ever sign for a given user's avatar. */
export function avatarKeyPrefix(userId: string): string {
  return `avatars/${userId}/`;
}

/**
 * A link to someone's uploaded picture, or null when there is nothing to show.
 *
 * Null is a normal answer, not a failure: most accounts have no upload, and an
 * unconfigured bucket must degrade to the initials avatar rather than break every
 * screen that renders a person. A signing error is swallowed for the same reason
 * — a profile that fails to load because a picture could not be signed would be a
 * decoration taking down the page it decorates.
 */
export async function avatarUrl(
  storage: StorageService,
  key: string | null | undefined,
): Promise<string | null> {
  if (!key || !storage.configured) return null;
  return storage
    .presignDownload(key, 'avatar', true, AVATAR_URL_TTL_SECONDS)
    .catch(() => null);
}
