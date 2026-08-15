import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The VFW mark, loaded once at boot and shared by the email template
 * ({@link ../common/email.ts}) and the global PDF template
 * ({@link ../common/pdf-template.ts}) — one file, read from one place, so a
 * new logo takes effect everywhere it appears at once instead of three copies
 * drifting apart.
 *
 * Missing gracefully: `readFileSync` throwing (a deploy that hasn't shipped
 * `backend/assets/vfw-logo.jpg`) leaves both exports `undefined` rather than
 * crashing boot — the email and PDFs still render exactly as before, just
 * without the mark.
 */
const LOGO_PATH = join(__dirname, '..', '..', 'assets', 'vfw-logo.jpg');

export const VFW_LOGO: Buffer | undefined = (() => {
  try {
    return readFileSync(LOGO_PATH);
  } catch {
    return undefined;
  }
})();

/** Inline form for HTML email — see the header in `common/email.ts`. */
export const VFW_LOGO_DATA_URI: string | undefined = VFW_LOGO
  ? `data:image/jpeg;base64,${VFW_LOGO.toString('base64')}`
  : undefined;
