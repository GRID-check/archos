/**
 * Re-grant the office-shelf permission to every role that holds its old slug —
 * or show what it would do.
 *
 * `org:archiv:manage` became `org:office_shelf:manage`. The catalog keeps the old
 * slug (marked deprecated) and every check accepts either for one release, so a
 * custom role built in WorkOS keeps working untouched. This script is the step
 * after the deploy that makes the new slug the one the roles hold: for each
 * role that holds the old slug and not the new, it ADDS the new one. It never
 * removes the old slug (that is a later release's step, see the runbook), so
 * running it twice, or half way, changes nothing that was already right.
 *
 *   Usage (from frontends/ui):
 *     WORKOS_API_KEY=sk_… bun run regrant:office-shelf             # list the roles, change nothing
 *     WORKOS_API_KEY=sk_… bun run regrant:office-shelf -- --apply  # add the new slug to each
 *
 * Run it AFTER the deploy: the authz-catalog Job (`grid-app-authz-catalog`)
 * creates `org:office_shelf:manage` in WorkOS, and a role cannot be given a
 * permission that does not exist yet. The script checks that first and stops.
 *
 * It covers the environment roles and, organization by organization, the roles
 * only that organization has (the custom roles an office builds for itself).
 * `docs/deployment/office-shelf-rename-runbook.md` is the whole sequence.
 */

import { WorkOS, type Role } from '@workos-inc/node'

const OLD_SLUG = 'org:archiv:manage'
const NEW_SLUG = 'org:office_shelf:manage'

const apply = process.argv.includes('--apply')
const apiKey = process.env.WORKOS_API_KEY
if (!apiKey) {
  console.error('WORKOS_API_KEY is required.')
  process.exit(2)
}

const workos = new WorkOS(apiKey)
const note = (message: string) => console.log(`  ${message}`)

const holdsOldOnly = (role: Pick<Role, 'permissions'>): boolean =>
  role.permissions.includes(OLD_SLUG) && !role.permissions.includes(NEW_SLUG)

/** Roles that need the new slug, as `[where, role]`. */
interface Pending {
  readonly where: string
  readonly slug: string
  readonly permissions: readonly string[]
  readonly grant: () => Promise<void>
}

async function newSlugExists(): Promise<boolean> {
  let after: string | undefined
  do {
    const page = await workos.authorization.listPermissions({ after, limit: 100 })
    if (page.data.some((permission) => permission.slug === NEW_SLUG)) return true
    after = page.listMetadata?.after ?? undefined
  } while (after)
  return false
}

async function collectPending(): Promise<Pending[]> {
  const pending: Pending[] = []

  const environmentRoles = (await workos.authorization.listEnvironmentRoles()).data
  for (const role of environmentRoles.filter(holdsOldOnly)) {
    pending.push({
      where: 'environment',
      slug: role.slug,
      permissions: role.permissions,
      grant: async () => {
        await workos.authorization.setEnvironmentRolePermissions(role.slug, {
          permissions: [...role.permissions, NEW_SLUG],
        })
      },
    })
  }

  const organizations = await (await workos.organizations.listOrganizations({ limit: 100 })).autoPagination()
  for (const organization of organizations) {
    const roles = (await workos.authorization.listOrganizationRoles(organization.id)).data
    for (const role of roles.filter((candidate) => candidate.type === 'OrganizationRole' && holdsOldOnly(candidate))) {
      pending.push({
        where: `organization ${organization.id} (${organization.name})`,
        slug: role.slug,
        permissions: role.permissions,
        grant: async () => {
          await workos.authorization.setOrganizationRolePermissions(organization.id, role.slug, {
            permissions: [...role.permissions, NEW_SLUG],
          })
        },
      })
    }
  }
  return pending
}

async function main(): Promise<void> {
  console.log(`Office-shelf permission: ${OLD_SLUG} -> ${NEW_SLUG} (${apply ? 'APPLY' : 'dry run, nothing is written'})`)

  if (!(await newSlugExists())) {
    console.error(`\n${NEW_SLUG} does not exist in this WorkOS environment yet. Deploy first: the authz-catalog Job creates it.`)
    process.exit(1)
  }

  const pending = await collectPending()
  if (pending.length === 0) {
    console.log('\nNo role holds the old slug without the new one. Nothing to do.')
    return
  }

  console.log(`\n${pending.length} role(s) hold ${OLD_SLUG} without ${NEW_SLUG}:`)
  for (const item of pending) note(`${item.slug}  in ${item.where}`)

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to add the new slug to each. The old slug stays.')
    return
  }

  let failed = 0
  for (const item of pending) {
    try {
      await item.grant()
      note(`granted  ${item.slug}  in ${item.where}`)
    } catch (error) {
      failed += 1
      note(`FAILED   ${item.slug}  in ${item.where} — ${String(error)}`)
    }
  }
  console.log(`\nGranted ${pending.length - failed} of ${pending.length}.`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
