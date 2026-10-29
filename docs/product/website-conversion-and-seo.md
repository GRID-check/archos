# The public site: who it is for, what it ranks for, what it still lacks

How the public website (`apps/website`) is meant to convert and be found. **Current plan,
2026-10-29**, written with the rebrand: the owner decided not to port the old site's content
(D7), to keep SEO a priority with new pages aligned to the brand (D8), to leave the blog as it is
(D13) and to keep every route brand-free (D14). The plan it replaces, written for the old site in
September 2026, is summarised at the end and lives on in git history.

The research behind it (search clusters, what ranks today, sources) is the SEO scout's plan of
2026-10-29; the September audit [`seo-geo-audit-2026-09.md`](seo-geo-audit-2026-09.md) is kept
for its landscape. How the pieces are built: [`apps/website/README.md`](../../apps/website/README.md#seo).

## Who reads the site, and what each needs to see

| Reader | Arrives with | Needs to leave with | Where the site answers |
|---|---|---|---|
| Office principal (buyer) | "Is this worth my team's time, and is it safe?" | What the workspace takes over, what stays with the planners, a clear data answer | Home, `/ki-fuer-architekturbueros/`, `/datensicherheit/` |
| Project lead (champion) | A task: a new plan revision, a building-law question | Proof that the work is done in the project and every answer is traceable | `/planstaende-vergleichen/`, `/baurecht/` |
| Planner (user) | A search for the task ("Pläne vergleichen", "welche OIB-Richtlinie gilt") | A useful page, then a reason to try | The work pages, the journal |
| Data or IT decider (gatekeeper) | "Where do our drawings go?" | Hosting, providers, no training, a data processing agreement | `/datensicherheit/`, the privacy policy |

## The conversion path

One action: **request a demo on a real project** (`/demo/`). Every page ends in the same
`CTABand`: "Demo anfragen" first, "Datensicherheit" second (the security page ends with
contact instead). The form hands off to the visitor's mail program for now (D9); its funnel is
measured in PostHog (`apps/website/README.md`, "Analytics").

## Pages and the searches they meet

The header stays Plattform · Datensicherheit · Blog (design system). The product pages are in the
footer's product column and linked from home and from each other.

| Cluster (German first) | Page | Status |
|---|---|---|
| KI im Architekturbüro, KI Architekturbüro Software, KI Planungsbüro, ChatGPT für Architekten | `/ki-fuer-architekturbueros/` · `/en/ai-for-architecture-firms/`, and the journal post it links to | live |
| Pläne vergleichen, Planänderungen erkennen, Planstand vergleichen, Raumprogramm prüfen | `/planstaende-vergleichen/` · `/en/comparing-plan-revisions/` | live |
| OIB-Richtlinien, Bauordnung, Gebäudeklasse vs. Bauklasse, Einreichung prüfen | `/baurecht/` · `/en/building-law/` (the old hub's address, kept) | live |
| KI und Datenschutz im Büro | `/datensicherheit/` · `/en/security/` | live |
| Wissensmanagement Architekturbüro, Projektwissen, Büroarchiv | `/projektwissen/` · `/en/project-knowledge/` | wave 2; home and the journal meanwhile |
| IFC-Modell prüfen, IFC im Browser, Raumbuch | `/modelle-pruefen/` · `/en/model-checking/` | wave 2 |
| What changed in the product | `/changelog/` · `/en/changelog/` | arrives with the cutover |

How "KI" is used: in the slug, title, H1 and FAQ questions of the one page searchers reach with
it. In body copy the product is the subject and KI an attribute; never "KI-Workspace", "Tool" or
"Copilot". Competitors are described by category ("allgemeine Chat-Assistenten"), never by name.

## Route fates

Every address of the old site has one fate, in `apps/website/redirects.mjs`:

| Old pages | Fate |
|---|---|
| The comparison hub and its ten product comparisons | 301 to `/ki-fuer-architekturbueros/` (the one about searching the law yourself: `/baurecht/`) |
| The audience hub, the architecture and the engineering offices | 301 to `/ki-fuer-architekturbueros/` |
| The builders' audience page | **410**: not an audience of the product |
| The old "why this product" page | 301 to `/ki-fuer-architekturbueros/` |
| The use-case hub | 301 to home; eight building-law use cases to `/baurecht/`; office archive and file notes to home until `/projektwissen/` ships |
| The nine state pages under `/baurecht/<land>/` and the ten glossary entries | 301 to `/baurecht/` |
| The weekly "what's new" page | 301 to `/changelog/` |
| The value calculator | **410**: its numbers were assumed, not measured |
| The unlisted press page of the old brand art and its ZIP downloads | **410** |
| `/llms-full.txt` | 301 to `/llms.txt` |
| The four blog posts whose slug carried the old name | 301 to their new brand-free slugs |
| The old `/de/<path>` and `/en/<German segment>/<path>` aliases | 301 straight to the final target of `<path>` |
| Home, legal pages, blog, categories, other posts, `/baurecht/`, `/rss.xml`, `/llms.txt` | served at the same address |

Every 301 lands in one hop on a page that answers 200, held by `src/lib/route-fates.test.ts` and
by `bun run check:routes` against the built server. On the domain cutover (D2) the old domain
forwards host and path, and this table resolves from there: two hops at most.

Owner overrides worth a look: the Gebäudeklasse glossary entry was the old site's best ranking
chance (recover it as a journal post when the blog reopens); the builders' page could 301 to home
instead of 410; the comparison rankings that named other products will fade (accepted, the brand
names no competitor).

## Technical SEO, as built

- **Metadata:** `<Seitenname> – <name>` titles (home: name first), descriptions in planning
  language, self-referencing canonicals, hreflang `de`/`en`/`x-default` from the route table.
- **Structured data:** `Organization` and `WebSite` everywhere; `BreadcrumbList` on every
  indexed inner page; `FAQPage` wherever the FAQ renders, from the same items;
  `SoftwareApplication` on home without price or rating; `BlogPosting` on each post from its
  frontmatter. `bun run check:structured-data` parses every block in the build.
- **Sitemap:** every page with its other-locale twin and a `lastmod` (post date, or the last
  commit of the page's view and copy when the build has git).
- **Feeds and answer engines:** RSS at the old `/rss.xml` and `/en/rss.xml`; a short `/llms.txt`
  generated from identity and the page copy. Answer engines rank from the HTML and the JSON-LD;
  llms.txt only spares them guesswork.
- **Social previews:** one share card for every page (generated per-page cards are open below).

## Rules the copy keeps

- Belegpflicht: every product claim names its evidence in a comment in the page's copy file
  (`VISION.md`, a release note, an owner decision). What cannot be verified is reworded to what can.
- No edition or date of the legal corpus; no number that was not measured.
- Sie, colon gendering, no exclamation marks, headings end with a full stop, the product's name
  only as `{name}`: `scripts/check_brand_rules.mjs` holds what a machine can.

## Open, and who can close it

| Gap | What closes it |
|---|---|
| Search Console and Bing for the new domain | Owner: verify the domain property, submit `/sitemap-index.xml`, run Change of Address from the old domain once the 301s are live (D2), watch the 404 report weekly for a month and add rows for anything missed |
| `sameAs` in the Organization data | Owner: the LinkedIn company page and the founders' profiles (`src/lib/social.ts`) |
| Wave 2 pages: `/projektwissen/`, `/modelle-pruefen/` | Copy and confirmations of the features they name (Outlook archive, Behörden-Gedächtnis, IFC versions); then their rows replace the home fallback in `redirects.mjs` |
| Per-page social cards | A designed 1200 × 630 card per page (plan: General Sans title, wordmark, one motif per page) and fonts the renderer reads |
| Product screenshots that still show the old name inside the interface (the plan revision image) | New captures from a demo organisation |
| Measured pilot evidence, one case study | Per pilot: questions asked, time before and after; one office's permission |

## The plan this replaces (September 2026, old site)

The old site was rated 7.2/10 by an outside teardown: strong on positioning and trust, weak on
proof and search. Its plan answered with breadth: a comparison page per competing product, a page
per Austrian state, ten glossary entries, ten use cases, audience pages, a value calculator, and
"send a real planning question" as the one action. The rebrand drops that breadth (D7): the
comparisons named competitors, the state pages went stale with every edition, and the calculator
claimed what was not measured. The search intent they served now lands on the three work pages
through the route fates above. Kept from it: the readers and what each needs, measured claims only,
and the open evidence gaps.
