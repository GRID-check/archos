/**
 * The company's profiles on other sites. The footer, the contact page, the
 * privacy policy's LinkedIn row and the JSON-LD `sameAs` read this, and each
 * shows nothing for a profile that is not set, so the site never links to a
 * placeholder.
 *
 * TODO(owner): set the company's LinkedIn page URL. No URL for it exists in the
 * repository (searched apps/site, docs, packages/brand). Better still, add it to
 * packages/brand/identity.json so the app can read it too, and read it from there.
 */
export const linkedinUrl = null as string | null;

/** Every profile that is set, for schema.org `sameAs`. */
export const socialProfiles: string[] = linkedinUrl === null ? [] : [linkedinUrl];
