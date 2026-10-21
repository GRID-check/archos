/**
 * The request shape of `POST /api/user/preferences`, shared by the route and the
 * MCP catalog (ADR-0121).
 */

import { z } from 'zod'

export const updatePreferencesSchema = z.object({
  prefs: z.record(z.unknown()),
})
