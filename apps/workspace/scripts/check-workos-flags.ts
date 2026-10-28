/**
 * Every feature-flag slug the code reads must exist in this WorkOS environment.
 * Read-only: it lists the environment's flags and writes nothing.
 *
 *   Usage:
 *     WORKOS_API_KEY=sk_… task workspace:provision:flags
 *
 * ## Why this exists
 *
 * Flags are always enforced (`bff/authz/feature-flags.ts`), and a slug
 * WorkOS does not know is OFF for every organization. The registry is
 * TypeScript and the flags are remote state, so nothing in `task verify` can
 * see across the gap: a slug added to the registry without being created in
 * WorkOS ships a feature that is dark in production and says nothing about why.
 * That happened — `mail-import` reached both stacks with no flag behind it.
 *
 * A registry slug missing from the environment fails the run (exit 1). A flag
 * the environment has and the registry does not is reported, never failed: it
 * is a retired flag waiting for somebody to delete it in the dashboard, which
 * this script will not do.
 *
 * `provision:workos-env` reports the same missing slugs among everything else
 * it checks; this is the one question on its own, cheap enough to run on a
 * schedule (the WorkOS drift workflow) without the platform-organization and
 * origin settings that script needs.
 */

import { WorkOS } from '@workos-inc/node'

import { REGISTRY_FLAG_SLUGS } from '../bff/authz/feature-flags'
import { planFlagCheck } from './provision-workos-env-plan'

async function listEnvironmentFlagSlugs(workos: WorkOS): Promise<string[]> {
  const slugs: string[] = []
  let after: string | undefined
  do {
    const page = await workos.featureFlags.listFeatureFlags({ after })
    slugs.push(...page.data.map((flag) => flag.slug))
    after = page.listMetadata?.after ?? undefined
  } while (after)
  return slugs
}

async function main(): Promise<number> {
  const apiKey = process.env.WORKOS_API_KEY
  if (!apiKey) {
    console.error('WORKOS_API_KEY is required.')
    return 2
  }
  const present = await listEnvironmentFlagSlugs(new WorkOS(apiKey))
  const plan = planFlagCheck(REGISTRY_FLAG_SLUGS, present)

  console.log('Feature flags: registry → WorkOS (read-only)')
  for (const slug of plan.present) console.log(`  ok       ${slug}`)
  for (const slug of plan.missing) console.log(`  MISSING  ${slug} — off for every organization until it is created`)
  for (const slug of plan.unknown) console.log(`  RETIRED? ${slug} — in WorkOS, read by no code; delete it in the dashboard`)

  if (!plan.ok) {
    console.error(
      `\n${plan.missing.length} registry flag(s) missing in WorkOS. Create each in the dashboard ` +
        '(docs/deployment/workos-provisioning.md §6) in BOTH environments.'
    )
    return 1
  }
  console.log('\nWorkOS has every registry flag.')
  return 0
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error('Feature-flag check failed:', error)
    process.exit(1)
  }
)
