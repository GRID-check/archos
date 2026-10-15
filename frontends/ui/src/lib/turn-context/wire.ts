import { z } from 'zod'

export const turnContextRequestSchema = z.object({
  query: z.string().trim().max(2000).optional(),
}).strict()

export const turnContextResponseSchema = z.object({
  projectContext: z.string().nullable(),
  projectMemory: z.string().nullable(),
  orgInstructions: z.string().nullable(),
  /**
   * The conversation drew on another project that still restricts its readers
   * (an active one, ADR-0094): the turn starts with every door a whole project
   * reads shut, memory included, instead of learning it from a refusal. Content
   * from a closed project does not count.
   */
  drewOnOtherProjects: z.boolean(),
  /**
   * The office's reference projects, one line each: the closed projects most
   * like this one (`lib/cross-project/reference-brief.ts`), so the agent can
   * look there unasked. Null when the office has none.
   */
  referenceProjects: z.string().nullable(),
  /**
   * The person whose turn it is, as WorkOS knows them (`requester.ts`), so the
   * agent can address them by name. Null when WorkOS could not be read.
   */
  requester: z.object({
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string().nullable(),
  }).strict().nullable(),
  /** The office's display name (`getOrganizationDisplayName`). Null when unknown. */
  officeName: z.string().nullable(),
}).strict()

export const turnContextApiResponseSchema = z.object({ data: turnContextResponseSchema }).strict()

export type TurnContextRequest = z.infer<typeof turnContextRequestSchema>
export type TurnContextResponse = z.infer<typeof turnContextResponseSchema>
export type TurnContextRequester = NonNullable<TurnContextResponse['requester']>
export type TurnContextApiResponse = z.infer<typeof turnContextApiResponseSchema>
