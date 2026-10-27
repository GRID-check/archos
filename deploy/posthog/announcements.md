# Sending an announcement

Use this when every member, or a slice of them, should learn in the app that
something changed: a new guideline in the knowledge base, a different default
model, a planned maintenance window. It is a PostHog **product tour** of the
*announcement* (a window in the middle of the screen) or *banner* (a strip at the
top) type. PostHog shows it, remembers per browser who has seen or closed it, and
counts reach. Nothing in Piloti has to be deployed for a new one.

What it is not: an email (PostHog has no address of anyone, see the privacy
posture in `frontends/ui/src/lib/analytics/posthog.ts`), and not a record a
member can find again later. A member who has turned off usage analytics in
their profile does not see announcements either.

## Once per project

1. PostHog → **Product tours** → enable it for the project. posthog-js loads
   tours through remote config by itself; the app passes no
   `disable_product_tours`, so nothing else is needed.
2. Check that the privacy notice still lists the tour keys
   (`frontends/ui/src/lib/legal/content`, "ph_product_tour_…"). It does since
   2026-10-27; a new key posthog-js starts writing goes there too.

## Each announcement

1. **Product tours → New → Announcement** (or **Banner** for something
   ongoing, such as maintenance tonight).
2. **Content.** Title and two or three sentences: what changed, what it means
   for the reader, one link if there is more (the changelog entry, a guide).
   German first, then add an **English translation**: the tour picks it from
   the browser language.
3. **Who sees it** (Targeting → person properties, set by the app after
   sign-in):

   | Property | Values | For |
   |---|---|---|
   | `organization_id` | the WorkOS organization id (`org_…`) | One office |
   | `organization_name` | the office's name | Same, easier to read |
   | `user_role` | `admin`, `member`, `org-platform-owner` | Admins only, e.g. a new setting |
   | `locale` | `de`, `en` | One language |

   A person gets these on their next page load after sign-in; anyone who has
   not opened Piloti since 2026-10-27 has none yet, so a filter on them misses
   them.

   **Always add a URL condition**: staging and production share project 269895,
   so "URL contains `app.piloti.at`" for production, `app.dev.piloti.at` for
   staging. Without it the announcement shows in both.
4. **When.** Set an end date for anything that stops being news. Leave the
   frequency at "once": a closed announcement does not come back.
5. **Try it on staging first**: a copy targeted at `app.dev.piloti.at` and your
   own `organization_id`, then launch the production one.

## Did it reach people

PostHog captures `product tour shown`, `product tour dismissed`,
`product tour completed` and `product tour button clicked`, each with
`$product_tour_id` and `$product_tour_name`; the tour's own page shows the same
numbers. Shown ÷ weekly active people of the target is the reach.

The app's own onboarding tour (`features/onboarding`) is a different thing: it
sends `product_tour_completed` / `product_tour_skipped` with underscores.
