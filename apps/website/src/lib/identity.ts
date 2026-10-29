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
