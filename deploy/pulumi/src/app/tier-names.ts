/**
 * The names of the backend's chat and api tiers (ADR-0145 row 10c): each tier's
 * StatefulSet or Deployment, its Services, HPA, PDB, KEDA objects and the pod
 * label NetworkPolicies select on.
 *
 * The rename recreates every one of them, and the chat tier holds live sockets
 * and turns for up to its drain, so it rolls out expand, switch, contract. This
 * is the expand step: the tiers under the new names run beside the legacy ones,
 * and every caller still dials the legacy Services. The switch points the
 * callers at the new names; the contract deletes the legacy tiers and these two
 * constants once the old chat tier has drained.
 */
export const CHAT_TIER = "chat";
export const API_TIER = "api";

/** The chat tier's name before ADR-0145, served until the switch. */
export const LEGACY_CHAT_TIER = "aiq-agent";
/** The api tier's name before ADR-0145, served until the switch. */
export const LEGACY_API_TIER = "aiq-api";

/** Both names of each tier while the two run side by side. */
export const CHAT_TIERS = [LEGACY_CHAT_TIER, CHAT_TIER] as const;
export const API_TIERS = [LEGACY_API_TIER, API_TIER] as const;
