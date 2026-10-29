# website

The public website of the company, built with Astro as a static site. It replaces `apps/site`
(slice 5 of [the corporate design plan](../../docs/design/corporate-design-plan.md)): the `web`
image builds this directory (`ci/image_inputs.py`), and `apps/site` stays in the tree only until
its cutover deletes it.

Every visual value comes from the shared design system in `packages/brand`. The brand strings come
from `src/lib/identity.ts`, which reads `identity.json`.

## Run

```bash
bun install        # first, and after a pull that moves bun.lock
bun run dev        # http://localhost:4321
bun run build      # static output in dist/
bun run build && node runtime/server.mjs     # serve it as production does: headers, /healthz, 404
bun run check      # astro check, the brand copies (sync --check), then the brand rules (scripts/check_brand_rules.mjs)
bun run test       # runtime specs (node --test) and src/**/*.test.ts (bun test)
bun run check:a11y # after a build: axe-core WCAG 2.2 AA on every page, DE and EN (needs Playwright's Chromium)
bun run check:routes           # after a build: every old address answers its route fate (301 in one hop, or 410)
bun run check:structured-data  # after a build: every JSON-LD block parses and carries its type's required fields
```

Or from the repo root: `task website:install`, `task website:check`, `task website:build`, and
`task website:verify` for everything CI runs.

## Production server

`runtime/server.mjs` wraps the Astro node adapter's handler:

- **Security headers** on every response (`runtime/security-headers.mjs`): a Content-Security-Policy
  with `script-src 'self'` (plus PostHog's two EU origins when analytics is on) and no inline script
  at all, which `vite.build.assetsInlineLimit: 0` in `astro.config.mjs` makes true; `frame-ancestors
  'none'`, HSTS (no `includeSubDomains`: that is the domain owner's call), `nosniff`, Referrer-Policy,
  COOP and a Permissions-Policy. JSON-LD is data and needs no allowance.
- **`/healthz`** answers `ok` from the process itself; the Dockerfile's healthcheck uses it.
  The Kubernetes probes in `deploy/pulumi` still hit `/` (a static page, so also cheap).
- **Cache-Control** for static files (`runtime/cache-control.mjs`).

Unknown addresses get `src/pages/404.astro`, rendered on request so `/en/...` answers in English,
with status 404 and `noindex`. Old public addresses and their fates (301, or 410 Gone) are in
`redirects.mjs`; see [SEO](#seo). `runtime/gone.mjs` turns the 404 of a gone address into 410.

## Analytics

PostHog EU, through the official SDK and its built-ins. `/web-analytics.js` (`runtime/web-analytics.mjs`)
loads `posthog-js` when the container has `PUBLIC_POSTHOG_HOST` and `PUBLIC_POSTHOG_PROJECT_TOKEN`, and
answers an empty script otherwise.

**Consent, quietly** (owner decision D24). Until the visitor chooses, PostHog counts cookieless
(`cookieless_mode: 'on_reject'`, `opt_out_capturing_by_default: true`): nothing is stored on the device.
`src/components/ConsentNote.astro` shows a small note in the corner with two equal choices; "Accept"
calls `posthog.opt_in_capturing()` (the SDK then keeps `ph_<token>_posthog` as cookie and in
localStorage, and session replay may run with every input and text masked), "Decline" calls
`posthog.opt_out_capturing()` (stays cookieless). The SDK stores the choice in localStorage
(`__ph_opt_in_out_<token>`); the footer's "Cookie-Einstellungen" reopens the note. Without analytics
configured the note and the footer link never appear.

**The PostHog project must have cookieless server hash mode set to "stateful"**
(Settings, Project, Web analytics), or PostHog discards every cookieless event. On 2026-10-29 it was
off (`cookieless_server_hash_mode: 0`); the owner switches it.

What is measured, all by the SDK unless named:

| Signal | Source |
|---|---|
| Page views, page leaves with scroll depth (`$prev_pageview_max_scroll_percentage`), referrer, UTM parameters | `$pageview`, `$pageleave`, automatic |
| Web vitals (LCP, INP, CLS, FCP) | `capture_performance.web_vitals` |
| Clicks on links and buttons, form submits and changes, rage and dead clicks | autocapture |
| Where a call to action sits | `data-ph-capture-attribute-cta-area` and `-cta-label` on `Button`, `TextLink`, `CTABand` (areas: `header`, `mobile_menu`, `founders`, `security_cta`, `contact_info`; labels: `demo`, `login`, `open_app`, `contact`) |
| Language switch | `data-ph-capture-attribute-language-switch` (`de-en`, `en-de`) on the header link |
| Which form | `data-ph-capture-attribute-form` (`contact`, `demo`) on the form |
| `form_submitted` `{ form, method: 'mailto', locale, newsletter? }` | `MailForm.astro`, the one thing autocapture cannot see: the mail hand-off. No field values |
| `video_played` `{ video, locale }` | `Video.astro`, first play |
| Heatmaps | `enable_heatmaps` |

No event carries what a visitor typed. Dashboards: PostHog's Web Analytics product is the dashboard
(no dashboard as code). The demo funnel to build there: `$pageview` on `/demo/` (or `/en/demo/`), then
`$autocapture` change with `form = demo`, then `form_submitted` with `form = demo`.

## Forms

Contact and demo hand off to the visitor's mail program (owner decision D9): `MailForm.astro` builds a
`mailto:` with a subject and a readable `Label: value` body (`src/lib/mailto.ts`), opens it, and shows
what happens next and the address to write to if no mail program opened. Without JavaScript the
browser's own `mailto:` post is the fallback. Nothing reaches a server of ours, so nothing is stored.

Roadmap: the target is Attio. A form posts to an endpoint that creates the person and the request in
Attio, so a lead is recorded and answered from the CRM. Attio has a REST API and an MCP server, so an
agent can read and act on the same records (AI-native tooling).

## Accessibility

`bun run check:a11y` (`scripts/check-accessibility.mjs`) serves `dist/` and runs axe-core with the
WCAG 2.0, 2.1 and 2.2 A/AA rules on every page in the sitemap plus the 404 page, at 1280 and 390 px,
with the mobile menu open and a form in its sent state. Text on a photo, which axe can only flag for
review, is measured against every pixel behind it. It fails on any finding, and `task website:verify`
runs it.

## Layout

| Path | What it is |
|---|---|
| `src/layouts/BaseLayout.astro` | `<head>`, skip link, header, `<main>`, footer. Every page uses it. |
| `src/components/` | One Astro component per design-system component, ported from `packages/brand/react`. |
| `src/lib/identity.ts` | Typed brand strings, read from `identity.json`; `withName` fills `{name}` in copy. |
| `src/i18n/` | Languages: the route table (`paths.ts`), the shell strings (`ui.ts`), navigation (`nav.ts`) and page copy (`pages/`). See [Languages](AGENTS.md#languages). |
| `src/views/` | Page markup, one view per page, rendered for both locales. |
| `src/styles/brand/` | Committed copy of the design system (tokens, components, fonts, identity). Generated, never edited. |
| `src/styles/site.css` | Page glue only: skip link, `[hidden]`, image sizing. Uses tokens. |
| `public/media/` | Images, video and logos for the pages (table below). |

## Styles and brand

The files in `src/styles/brand/` are copies. `node packages/brand/sync.mjs` writes them from the
package, and `node packages/brand/sync.mjs --check` (run by `bun run check`) fails when a copy has
drifted. Change a token or a brand string in `packages/brand`, then sync.

## Media

Reference media from the eight-page reference site, renamed in English by what each file shows.
The table gives the source file and where it appears.

| File in `public/media/` | Reference file | Where it is used |
|---|---|---|
| `planner-design-photo.webp` | `870709db80.webp` | Home, duo card "Planer:innen entwerfen." (photo, tinted) |
| `ai-search-compare-photo.webp` | `1097bac5d4.webp` | Home, duo card "KI sucht, vergleicht und prüft." (dark, photo) |
| `product-plan-revision-changes.webp` | `b3c4660c81.webp` | Home, product image under the hero (plan revision with sources) |
| `product-search-derivation.webp` | `895cf6a19d.webp` | Home, gallery slide 1, "Suchen" |
| `product-compare-clearance.webp` | `ffa209f24b.webp` | Home, gallery slide 2, "Vergleichen" |
| `product-model-check.webp` | `2a7b9ca2d2.webp` | Home, gallery slide 3, "Prüfen" (3D model check) |
| `product-floor-plan-query.webp` | `58af499fe3.webp` | Home, "Gebaut für Architektur- & Planungsbüros." (floor plan with questions) |
| `knowledge-video-poster.webp` | `c9e9e60311.webp` | Home, poster of the video "Das Wissen Ihres Büros wird nutzbar." |
| `knowledge-video.webm` | `28f2a93346.webm` | Same video, first source (WebM) |
| `knowledge-video.mp4` | `8cde9d7ebc.mp4` | Same video, second source (MP4) |
| `share-card.jpg` | none, cropped from the sign-in photo (`packages/brand/authkit/login-photo.webp` source) | Every page, `og:image` and `twitter:card` (1200 × 630, social previews) |
| `jonathan-uhlemann.webp` | none, from `apps/site/src/assets/team/jonathan-uhlemann.webp` | Home, founders row "Das Planungsbüro der Zukunft entsteht heute." (portrait, 4:5 crop, 208 × 208 source) |
| `matthias-bigl.webp` | none, from `apps/site/src/assets/team/matthias-bigl.webp` | Home, founders row (portrait, 4:5 crop, 208 × 208 source) |
| `ferdinand-rubenbauer.webp` | none, from `apps/site/src/assets/team/ferdinand-rubenbauer.webp` | Home, founders row (portrait, 4:5 crop, 208 × 208 source) |
| `team-conversation-photo.jpg` | `88395fbfb8.jpg` | Home, portrait beside the feld72 quote (grayscale) |
| `demo-panel-background.webp` | `99653e3df7.webp` | Demo, background of the form panel |
| `pilot-office-gerner-gerner-plus.svg` | `f3402543bd.svg` | Pilot office logo row (home, demo) |
| `pilot-office-zz-architecture.svg` | `3a9b73f14d.svg` | Pilot office logo row (home, demo) |
| `pilot-office-feld72.svg` | `1310a1a557.svg` | Pilot office logo row (home, demo) |
| `pilot-office-bewe-emp.svg` | `9e162c17b0.svg` | Pilot office logo row (home, demo) |
| `funding-aws-gray.png` | `e8ea93f801.png` | Footer, funding note (Austria Wirtschaftsservice) |

The reference fonts (`.woff2`) are not here: the design system ships them in `src/styles/brand/fonts/`.

## Icons

`public/favicon.svg` is a copy of `packages/brand/mark.svg`, its title filled from identity by
`packages/brand/build-brand-assets.mjs`. `favicon.ico`, `apple-touch-icon.png` and
`icons/icon-{192,512}.png`, `icons/icon-maskable-512.png` are rendered from the same master with that
script's recipe; the script itself still writes its rasters to `apps/site` until the cutover points it here. `src/pages/manifest.webmanifest.ts` names them, with the name from
identity and the colour from the tokens. Every page carries schema.org `Organization` and `WebSite`
JSON-LD (`src/lib/structured-data.ts`), all from identity.

## Not done here

- The changelog page comes with the cutover work.
- There is no login page. Login goes to `/sign-in`, which hands over to the app; `/login` and `/en/login` redirect there.
- The company's LinkedIn URL is not known yet (`src/lib/social.ts`, TODO(owner)); the footer, contact page, privacy row and JSON-LD show it once it is set.

## SEO

The plan, its search clusters and what is still open: [`docs/product/website-conversion-and-seo.md`](../../docs/product/website-conversion-and-seo.md).

**Route fates.** Every address of the old site has one fate in `redirects.mjs` (owner decision D7):
a 301 to the page that answers the same question today, in one hop to its final target, or 410
when nothing here does. The table is written as data: `PAGES` (old top-level pages), `SECTIONS`
(old sections and the fate of each detail slug), `RENAMED_POSTS` and `GONE_PREFIXES`; the `/de/*`
and `/en/<German segment>/*` aliases of the old site are derived from them. Astro answers the 301s
(`redirects` in `astro.config.mjs`). `src/pages/404.astro` asks `fateOf()` for anything no page
claimed: an alias the table does not spell out still gets its 301, and a gone address gets the
not-found view in its own words ("Diese Seite gibt es nicht mehr."), whose 404 `runtime/gone.mjs`
turns into 410 (Astro can send neither 410 from `redirects` nor a status of its own from the
error route). To change a fate, edit the row; `src/lib/route-fates.test.ts` fails a target that is
not a page, a chain, or a live page redirected away, and `bun run check:routes` asks the built
server for every row. A target other work adds (the changelog) is listed in `PENDING_TARGETS`
until it exists. Old spellings are history, so the brand-name checks skip `redirects.mjs`; tests
and scripts check those rows through the table and never spell them.

**Adding a page to the sitemap and the structured data.** A page in `ROUTES` (`src/i18n/paths.ts`)
is in the sitemap with its other-locale twin as the `xhtml:link` pair (`sitemap.mjs`). For its
`lastmod`, add its view and copy file to `PAGE_SOURCES` in `sitemap.mjs` (the date of their last
commit; the image build has no git, so there the page carries no date). Posts pair through
`translationSlug` and are dated by `pubDate`. JSON-LD comes from `BaseLayout`: every page has
`Organization` and `WebSite`; every indexed inner page gets a `BreadcrumbList` (Start › title;
pass `crumbs` for the levels between); a page that renders `FAQ` passes the same items as `faq`
and gets an `FAQPage`; anything else goes in `graph` (`SoftwareApplication` on home, `BlogPosting`
on a post, built in `src/lib/structured-data.ts`). No `offers` or ratings: there is no public price
and there are no public reviews. `bun run check:structured-data` holds all of it.

**Feeds and llms.txt.** `/rss.xml` and `/en/rss.xml` (`src/lib/feed.ts`, `@astrojs/rss`) keep the
old feed addresses; blog pages link them in `<head>`. `/llms.txt` is generated from identity, the
product pages' own titles and descriptions and the newest posts (`src/pages/llms.txt.ts`, copy in
`src/i18n/pages/llms.ts`).

**Social previews.** Every page shares `share-card.jpg`, with its own title and description.
Generated per-page cards (`astro-og-canvas`, or satori) were not adopted: each card needs a design
pass (the plan asks for a motif per page) and the brand fonts in a format the renderer reads (the
design system ships WOFF2 only), which no integration does simply. The plan's card spec stays in
the SEO doc as an open item.

## Signed in

A visitor who is signed in to the app sees "App öffnen" / "Open app" in the header instead of "Login".
The app keeps a contentless `signed_in=1` cookie on the website's domain while it has a session
([authentication flow](../../docs/technical-reference/authentication-flow.md#the-websites-signed_in-cookie)).
`src/scripts/signed-in.js`, loaded blocking in `<head>` from `BaseLayout`, sets `data-signed-in` on
`<html>` when it finds it, and `site.css` shows the matching one of the two buttons `Header.astro`
renders (`.site-signed-out`, `.site-signed-in`), so the swap happens before paint. Without the cookie or
without JavaScript the header says "Login". Both buttons go to `/sign-in`, which hands over to the app's
`/?sign-in`: the app opens for a browser with a session and signs in any other. The cookie is in the
privacy policy (`src/i18n/pages/privacy.ts`, "Anmeldestatus").

## Blog

Posts are MDX in `src/content/blog/<locale>/<slug>.mdx` (schema in
`src/content.config.ts`, categories in `src/lib/categories.ts`), figures in
`src/components/figures/`. A post's file name is its slug; `translationSlug`
names its twin in the other locale for the language switch and hreflang. Drafts
build only with `PUBLIC_INCLUDE_DRAFTS=1`. Until `apps/site` is deleted at the
cutover, its copies of these posts are stale: write new posts here.

Screenshots of every route for a PR: `bun run capture` (see [visual screenshots](../../docs/ux/visual-screenshots.md#website-targets)).
