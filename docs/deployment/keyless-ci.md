# Keyless CI: cutting over from stored keys

CI can prove which repository, branch and environment a job runs for with a
short-lived OIDC token GitHub signs for it. Pulumi Cloud, Anthropic and
OpenRouter exchange that token for a short-lived token of their own, so no
long-lived key has to be stored for them. A GitHub App replaces the personal
access token the release workflow pushes with.

Every workflow keeps working on its stored secret until the matching
repository variable is set, so each cut-over is three steps: configure the
vendor, set the variable, delete the old secret once a run has passed. The
policy and inventory this serves: [`../compliance/secrets-and-keys.md`](../compliance/secrets-and-keys.md).

## What GitHub's token says

Vendors match a token by its issuer, audience and subject. The issuer is
always `https://token.actions.githubusercontent.com`. The subject depends on
what started the job:

| Workflow | Subject (`sub`) |
|---|---|
| Deploy to staging (`environment: staging`) | `repo:GRID-check/grid-oib-agent:environment:staging` |
| Deploy to production (`environment: production`) | `repo:GRID-check/grid-oib-agent:environment:production` |
| Release notes (push to `develop`) | `repo:GRID-check/grid-oib-agent:ref:refs/heads/develop` |
| Claude code review (pull request) | `repo:GRID-check/grid-oib-agent:pull_request` |
| `@claude` (comments run on the default branch) | `repo:GRID-check/grid-oib-agent:ref:refs/heads/<default branch>` |

Pull requests from forks get no OIDC token at all, so none of this is
reachable from a fork.

## Pulumi Cloud (deploys)

Replaces `PULUMI_ACCESS_TOKEN`. Any edition; on Free the token is a personal
one of the organization's single user.

1. Pulumi Cloud → Settings → Access Management → OIDC Issuers → Register
   issuer: URL `https://token.actions.githubusercontent.com`.
2. Add a policy on it: decision Allow, token type Personal (Free) or
   Organization (Essentials and up), rules
   `aud` = `urn:pulumi:org:matthiasbigl` and
   `sub` = `repo:GRID-check/grid-oib-agent:environment:staging`. Add a second
   rule, or policy, for `...:environment:production`.
3. Repository variables (Settings → Secrets and variables → Actions →
   Variables): `PULUMI_OIDC_ORGANIZATION` = `matthiasbigl`. On Free also
   `PULUMI_OIDC_TOKEN_TYPE` = `personal` and `PULUMI_OIDC_SCOPE` =
   `user:matthiasbigl`; on Essentials and up `PULUMI_OIDC_TOKEN_TYPE` =
   `organization` and no scope.
4. Run the staging deploy (Actions → Deploy → Run workflow). The step "Log in
   to Pulumi Cloud" exchanges the token.
5. Delete `PULUMI_ACCESS_TOKEN` from the `staging` and `production`
   environments, and revoke the token in Pulumi Cloud. Add a line to the
   record in the policy.

How it is wired: `.github/actions/pulumi-login`, used by both jobs in
`.github/workflows/deploy.yml`, which hold `id-token: write`.

## Anthropic (`@claude` and Claude code review)

Replaces `CLAUDE_CODE_OAUTH_TOKEN`. **Billing changes:** that token draws on a
Pro/Max subscription; the federated token is billed as API usage in the
Console workspace it is bound to. Check the workspace's spend limit first.

1. Claude Console (admin or owner) → Settings → Service accounts: create one,
   for example `github-actions`, bound to the workspace CI should bill to.
2. Settings → Workload identity → Issuers: add GitHub,
   `https://token.actions.githubusercontent.com`.
3. Add a federation rule for the service account: audience
   `https://api.anthropic.com`, and a subject condition that admits this
   repository only, for example `sub` starting with
   `repo:GRID-check/grid-oib-agent:`. Note the rule id (`fdrl_…`), the
   organization id and the service account id (`svac_…`).
4. Repository variables: `ANTHROPIC_FEDERATION_RULE_ID`,
   `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`, and
   `ANTHROPIC_WORKSPACE_ID` if the rule targets more than one workspace.
5. Mention `@claude` on a pull request. Once it answers, delete
   `CLAUDE_CODE_OAUTH_TOKEN` (and `ANTHROPIC_API_KEY`, if it still exists).

How it is wired: `.github/workflows/claude.yml` and
`claude-code-review.yml` pass the variables to `anthropics/claude-code-action`
and send an empty static token once the rule is set, because a static
credential would win.

## GitHub App (release notes)

Replaces `RELEASE_PAT`. The app's token lives one hour and is revoked when the
job ends, and a push made with it triggers CI, which a `GITHUB_TOKEN` push
would not.

1. GitHub → Organization settings → Developer settings → GitHub Apps → New:
   name it, for example `piloti-release`; no webhook; repository permission
   **Contents: Read and write**, nothing else. Install it on this repository
   only.
2. Generate a private key (it downloads once).
3. Repository rulesets for `develop` (`protect-develop` and any other that
   applies): add the app to the bypass list.
4. Repository variable `RELEASE_APP_CLIENT_ID` (the app's client id) and
   repository secret `RELEASE_APP_PRIVATE_KEY` (the whole `.pem`).
5. After the next release-notes run pushes, delete `RELEASE_PAT` and revoke
   the PAT.

The private key does not expire: rotate it every 12 months (generate a new
one on the app, replace the secret, delete the old key).

## OpenRouter (release-note translation)

Replaces `OPENROUTER_API_KEY` for the release-notes workflow. Needs
OpenRouter's Business or Enterprise plan. The token lives 15 minutes; the
live turn-shape eval can run 30, so it keeps its stored key.

1. OpenRouter → Settings → Workload identity → Add issuer:
   `https://token.actions.githubusercontent.com`.
2. Create a workspace API key just for this (a monthly limit of a few
   dollars is plenty) and a policy that acts as it: audience
   `https://openrouter.ai`, subject
   `repo:GRID-check/grid-oib-agent:ref:refs/heads/develop`.
3. Repository variable `OPENROUTER_FEDERATION_POLICY_ID` = the policy's id.
4. The next release-notes run logs in through `.github/actions/openrouter-login`.
   Keep `OPENROUTER_API_KEY` for the turn-shape eval.

## What stays a stored secret in CI

| Secret | Why |
|---|---|
| `POSTHOG_CLI_API_KEY` | PostHog has no keyless login; scope it to one project and two scopes, on a bot user |
| `WORKOS_API_KEY_STAGING` | WorkOS has no keyless login; its own key, never the BFF's |
| `OPENROUTER_API_KEY` | The turn-shape eval outlives OpenRouter's 15-minute token |
| `RELEASE_APP_PRIVATE_KEY` | Only mints one-hour tokens; rotated every 12 months |
