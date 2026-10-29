# Website: contributor guide

This is the public website, built from the shared design system. Read the root
[`AGENTS.md`](../../AGENTS.md) too; this file adds what holds only here.

## Obligations

| When you | You must | Why |
|---|---|---|
| Need a style change | Change `packages/brand` (tokens or `css/components.css`), then run `node packages/brand/sync.mjs` | `src/styles/brand/` is a generated copy. A hand edit is overwritten by the next sync and fails `--check`. |
| Need a brand string (name, claim, address, e-mail, domain) | Read it from `src/lib/identity.ts` | Brand strings are copy. A typed name breaks at the next rename. |
| Build a page or a block | Use only the components in `src/components/` and the tokens | The design system is the one source. A new visual needs a design-system change first. |
| Add a value (colour, size, spacing) | Use a token from `tokens.css`. Never a literal | Spacing comes from the `--space-*` scale; no new colours or sizes in `site.css`. |
| Write German copy | Follow the German copy rules in [`packages/brand/README.md`](../../packages/brand/README.md) | Sie-form, colon gendering, no exclamation marks, buttons start with a verb, no AI jargon. |
| Name a file, a component or a class | English, brand-free, kebab-case files and PascalCase components | `ui-button`, `DuoCards`, never a product name. |
| Add an image | Put it in `public/media/` with an English kebab-case name, and add a row to the table in `README.md` | The table is how a reader finds out what a file shows. |
| Add an AI-generated image | Mark it with the `AITag` component | The design system requires the mark. |
| Write a component that scripts | Keep the script inline in the `.astro` file and keep state in attributes | No React, no framework runtime. |

## Layout

Every page renders through `src/layouts/BaseLayout.astro`, which provides the header, footer and
`<main>`. A page that needs no header (the split pages) passes `bare` to the same layout.
`src/lib/nav.ts` holds the navigation and footer links; change them there, not in a page.
