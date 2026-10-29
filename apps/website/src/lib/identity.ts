import identityJson from '../styles/brand/identity.json';

/** Every brand string the site prints. Copy lives in identity.json; code never types it. */
export interface Identity {
  name: string;
  claim: string;
  legalEntity: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  email: string;
  domain: string;
  tagline: string;
}

const identity: Identity = identityJson;

export default identity;

const NAME_TOKEN = /\{name\}/g;

/**
 * A string, or a dictionary of strings, with `{name}` replaced by the brand
 * name. Copy spells the name as `{name}` and goes through here once, so a
 * rename is one edit in identity.json. Mirrors `withProductName` in
 * apps/workspace/bff/brand.ts.
 */
export function withName<T>(value: T): T {
  if (typeof value === 'string') return value.replace(NAME_TOKEN, identity.name) as T;
  if (Array.isArray(value)) return value.map((item) => withName(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withName(item)]),
    ) as T;
  }
  return value;
}
