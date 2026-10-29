# Website: contributor guide

This is the public website, built from the shared design system. Read the root
[`AGENTS.md`](../../AGENTS.md) too; this file adds what holds only here.

## Obligations

| When you | You must | Why |
|---|---|---|
| Need a style change | Change `packages/brand` (tokens or `css/components.css`), then run `node packages/brand/sync.mjs` | `src/styles/brand/` is a generated copy. A hand edit is overwritten by the next sync and fails `--check`. |
| Need a brand string (name, claim, address, e-mail, domain) | Read it from `src/lib/identity.ts`; in copy write `{name}` and pass it through `withName` | Brand strings are copy. A typed name breaks at the next rename. |
| Add a page or a string | Provide `de` and `en`. Page copy in `src/i18n/pages/<key>.ts`, markup in `src/views/<Page>View.astro`, two thin route files (`src/pages/<de-path>.astro` and `src/pages/en/<en-path>.astro`). A new route is one row in `src/i18n/paths.ts`. Shell strings go in `src/i18n/ui.ts`. | The English dictionary is typed `typeof de`, so a missing key fails `astro check`. Pages written only in German are the thing this rule ends. |
| Build a page or a block | Use only the components in `src/components/` and the tokens | The design system is the one source. A new visual needs a design-system change first. |
| Add a value (colour, size, spacing) | Use a token from `tokens.css`. Never a literal | Spacing comes from the `--space-*` scale; no new colours or sizes in `site.css`. |
| Write German copy | Follow the German copy rules in [`packages/brand/README.md`](../../packages/brand/README.md) | Sie-form, colon gendering, no exclamation marks, buttons start with a verb, no AI jargon. |
| Name a file, a component or a class | Follow [`naming.md`](../../docs/contributing/naming.md#casing-and-form): English, brand-free, `PascalCase.astro` components, kebab-case everything else | `ui-button`, `DuoCards`, never a product name. |
| Add an image | Put it in `public/media/` with an English kebab-case name, and add a row to the table in `README.md` | The table is how a reader finds out what a file shows. |
| Add an AI-generated image | Mark it with the `AITag` component | The design system requires the mark. |
| Pair a blog post with its translation | Set `translationSlug` to the other locale's slug, and open both pages to check the language switch | Nothing yet: a slug that names no post breaks the switch and hreflang without an error |
| Edit a legal page (`/datenschutz`, `/impressum`, the English twins) | Leave no bracketed placeholder (`[14 Tagen]`, `[EU]`); a value nobody verified is marked `TODO(owner):` and listed in the pull request | Nothing yet: `check_brand_rules.mjs` does not look for brackets |
| Write a component that scripts | Keep the script inline in the `.astro` file and keep state in attributes | No React, no framework runtime. |

## Layout

Every page renders through `src/layouts/BaseLayout.astro`, which provides the header, footer and
`<main>`. A page that needs no header (the split pages) passes `bare` to the same layout.
`src/i18n/nav.ts` builds the navigation and footer links for a locale; change the labels in `src/i18n/ui.ts`
and the paths in `src/i18n/paths.ts`, not in a page.

## Languages

German is the default and lives at the root; English is under `/en/` with English first segments (`/datensicherheit` is `/en/security`).
Astro's `i18n` config in `astro.config.mjs` sets the locales and `prefixDefaultLocale: false`. Everything else goes through two files:

- `src/i18n/paths.ts`: `ROUTES`, one row per page with its `de` and `en` path. `localePath(key, locale)` builds a link, `alternateOf(pathname)` gives the other locale's twin (language switch and hreflang), `localeFromUrl(url)` reads the locale of a URL.
- `src/i18n/ui.ts` and `src/i18n/pages/<key>.ts`: the strings. Each exports `{ de, en }` with `en` typed `typeof de`. Brand name as `{name}`, filled by `withName`.

A view takes a `locale` prop and renders the page once for both locales. The two route files only say which locale: `<HomeView locale="de" />` and `<HomeView locale="en" />`. `BaseLayout` requires `locale`, and so do the components that print a UI string (`Gallery`, `Video`, `AITag`, `DuoCards`, `SplitPage`).

Converting a German-only page: move its copy to `src/i18n/pages/<key>.ts` with an English translation, move its markup to `src/views/<Page>View.astro`, write the two route files, and add its row to `ROUTES` if its path is new. The home page is the worked example (`src/i18n/pages/home.ts`, `src/views/HomeView.astro`).
Until a page is converted its English twin does not exist, so the language switch and hreflang on a German page point at a 404.

To capture a visual change for a PR, run `bun run capture` ([instructions](../../docs/ux/visual-screenshots.md#website-targets)).
