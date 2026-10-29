# website

The public website of the company, built with Astro as a static site. It replaces `apps/site` at
cutover (slice 5 of [the corporate design plan](../../docs/design/corporate-design-plan.md)); until
then both exist side by side and neither is deployed from here.

Every visual value comes from the shared design system in `packages/brand`. The brand strings come
from `src/lib/identity.ts`, which reads `identity.json`.

## Run

```bash
bun install        # first, and after a pull that moves bun.lock
bun run dev        # http://localhost:4321
bun run build      # static output in dist/
bun run build && node dist/server/entry.mjs   # serve it: pages are static, /sign-in runs on the server
bun run check      # astro check, the brand copies (sync --check), then the brand rules (scripts/check_brand_rules.mjs)
```

Or from the repo root: `task website:install`, `task website:check`, `task website:build`.

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
The favicon is `public/favicon.svg`.

## Not done here

- The pages themselves. Only the home page is converted (`src/views/HomeView.astro`, with thin route files in `src/pages/` and `src/pages/en/`). The other pages are still German-only and pass `locale="de"`.
- The demo page is a split page: `BaseLayout` with `bare`, no header or footer.
- There is no login page. Login goes to `/sign-in`, which hands over to AuthKit's hosted page; that page lists exactly the sign-in methods enabled in WorkOS, so the site keeps no list of its own. `/login` and `/en/login` redirect there.
- Deployment: Dockerfile, redirects and the removal of `apps/site` belong to slice 5.

## Blog

Posts are MDX in `src/content/blog/<locale>/<slug>.mdx` (schema in
`src/content.config.ts`, categories in `src/lib/categories.ts`), figures in
`src/components/figures/`. A post's file name is its slug; `translationSlug`
names its twin in the other locale for the language switch and hreflang. Drafts
build only with `PUBLIC_INCLUDE_DRAFTS=1`. Until `apps/site` is deleted at the
cutover, its copies of these posts are stale: write new posts here.

Screenshots of every route for a PR: `bun run capture` (see [visual screenshots](../../docs/ux/visual-screenshots.md#website-targets)).
