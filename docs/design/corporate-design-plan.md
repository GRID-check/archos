# Corporate design: one shared system, a greenfield website

The office is about to rebrand. The new corporate design (design system 3.0, handed
over as a zip with tokens, 25 components, fonts, logos and an eight-page reference
website) becomes one package every app reads, and the public website is rewritten
from scratch on top of it.

## North star

A rename or a colour change is one edit in `packages/brand`, and every surface
(website, workspace UI, e-mails, generated documents) follows on the next build.
No identifier anywhere carries the product's name.

## Slices

| # | Slice | Lands in | State |
|---|---|---|---|
| 1 | **Design system package.** `tokens.json` is the source; `tokens.css`, `components.css` (class prefix `ui-`, not the brand), fonts and logos are built from it. `identity.json` holds every brand string (name, claim, legal entity, address, e-mail) | `packages/brand/` | this change |
| 2 | **React components** typed in TSX, one file per component, no `window` global | `packages/brand/react/` | this change |
| 3 | **Brand-name rule** extended to the new name, so internal naming stays brand-agnostic | `scripts/check_brand_names.py` | this change |
| 4 | **Greenfield website** (Astro): Startseite, Datensicherheit, Blog, Kontakt, Impressum, Datenschutz, Demo (sign-in is AuthKit's hosted page in the same design, listing the methods WorkOS has enabled), built only from the package | `apps/website/` | done; in production as the `web` image |
| 5 | **Cutover**: Dockerfile and deploy for `apps/website`, blog posts and the changelog moved over, redirects for the old SEO URLs, then the old site deleted | deploy, CI | done 2026-10-29: the `web` image builds `apps/website`; the changelog renders at `/changelog/` from `apps/website/src/data/changelog.json`, which the release bot writes; old addresses have fates in `apps/website/redirects.mjs`; the old site deleted (the riso kit moved to `packages/brand/art/riso`, its claims rules into `scripts/check_brand_rules.mjs`); probes on `/healthz`. **Staged, not live** (owner decision D2): the domain move to the domain in `identity.json`, [`domain-cutover.md`](../deployment/domain-cutover.md) |
| 6 | **Workspace adopts the design**: General Sans, and the palette (light and dark) and radii of `ui/styles/tokens.css` as references to the package's `--ds-*` vars (`apps/workspace/shared/brand/tokens.vars.css`), the layers the brand has no token for mixed from brand tokens; the product name read from `identity.json` at the rebrand | `apps/workspace` | palette, font and radii done |

## How sharing works

Neither app's Docker build sees `packages/` (each builds from its own directory),
so the repo's existing pattern holds: `packages/brand/sync.mjs` writes committed
copies of the built files into each app, and `sync.mjs --check` fails CI when a copy
drifts from the package. `build-brand-assets.mjs` does the same for the mark and its rasters.

## Rules the package carries

- Brand strings are copy: read them from `identity.json`, never type them.
- Class names, files, component names and tokens are English and brand-free
  (`ui-button`, `ColorUsage`, never `ar-button` or `Farbeinsatz`).
- The design system's own rules (one primary button per area, one grey, no
  shadows, German copy with `Sie` and `:`-gendering) live in
  `packages/brand/README.md` and the component READMEs.
