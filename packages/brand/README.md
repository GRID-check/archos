# packages/brand: the corporate design

The one source for how the product looks and what it says in its public copy. The
website and the workspace UI read committed copies of the built files, so a token
or a brand string changes here and reaches every surface on the next sync.

## Layout

| Path | What it is |
|---|---|
| `tokens.json` | **Source of truth** for colours, type, spacing, radii, strokes, layout, motion. Every token carries its `usage` in German; a token with `"scope": "app"` belongs to the workspace only (see [Two layers](#two-layers-website-and-app)). |
| `identity.json` | Every brand string: name, claim, legal entity, address, e-mail, domain, hosting city. |
| `css/components.css` | Hand-maintained component classes (prefix `ui-`). Values come from the tokens. |
| `fonts/` | The two WOFF2 files (General Sans variable, Switzer Semibold). |
| `assets/logos/` | Client logos in grey (Pilotbüros, funding logo). The brand video is not here; it lives with the website. |
| `docs/components/` | One Markdown rules sheet per component, plus `ColorUsage.md`. |
| `docs/brand-basis.md` | What the brand says and stands for (Markenbasis): positioning, mission, values, antonyms, tonality, Belegpflicht, image families, logo clear space and minimum size, and which source wins when the Markenbasis and the design system disagree. |
| `build-tokens.mjs` | Builds `dist/tokens.css` (the website layer: shared tokens only) and `dist/tokens.vars.css` (the app layer: every token, app-scoped ones included, as variables prefixed `--ds-`, dark under `.dark` too) from `tokens.json`, and copies `css/` and `fonts/` into `dist/`. The workspace imports `tokens.vars.css` and maps its own names onto it rather than typing a value. |
| `sync.mjs` | Copies each app the files of its layer (`TARGETS`) and deletes any it no longer receives; copies `identity.json` alone into the agent's package (a `shared` target: nothing else there is touched); writes the product's name into the files listed in `name-copies.mjs`. `--check` writes nothing and fails on a stale, missing or unexpected file. |
| `name-copies.mjs` | The files that must spell the product's name as a literal (the service worker's fallback title, the icons' SVG `<title>`). `sync.mjs` fills them from `identity.json`, so a rename is still one edit (ADR-0148). |
| `dist/` | Built output, committed on purpose (see the root `.gitignore` negation). |
| `mark.svg`, `build-brand-assets.mjs` | The app icon master and its raster build (favicons and manifest icons for `apps/website` and `apps/workspace`, with the website's sharp). Unrelated to the tokens. The master's `<title>` is the token `{productName}`; every copy gets the name from `identity.json`. |
| `email-signatures.mjs`, `signatures/` | The founders' email signatures, text only, generated from `identity.json` (`--check` runs in the website's `bun run check`). Paste the HTML into the mail client. |
| `art/riso/` | The riso print kit (moved from the retired public site): its committed outputs are the app's empty-state vignettes; everything else exports to the gitignored `out/`. [`art/riso/README.md`](art/riso/README.md) |

Apps receive copies, not imports: neither Docker build sees `packages/`.

| Copy | Receives |
|---|---|
| `apps/website/src/styles/brand/` | `tokens.css`, `components.css`, `fonts/`, `identity.json` |
| `apps/workspace/shared/brand/` | `tokens.vars.css`, `fonts/`, `identity.json` |
| `packages/agent/src/agent/common/` | `identity.json` only: `agent.common.brand` reads the name from it |

## Two layers: website and app

The design system 3.0 is a website system: square shapes, 4px controls, no shadows. The
workspace is rebranded with a lighter hand on purpose and keeps a softer shape language of
its own. Both come from `tokens.json`, kept apart by scope:

| Layer | Tokens | Reaches |
|---|---|---|
| shared (no `scope`) | colours, type, spacing, strokes, layout, `focus-ring`, `glass-blur`, `radius-none`, `radius-md`, motion | website (`tokens.css`) and app (`tokens.vars.css`, as `--ds-*`) |
| app (`"scope": "app"`) | `shadow-raised`, `shadow-floating`, `shadow-modal`; the radius ladder `radius-inline`, `radius-control`, `radius-surface`, `radius-overlay`, `radius-bubble`, `radius-full` | app only |

The website copy holds no app token, so `var(--shadow-raised)` on the website resolves to
nothing, and `scripts/check_brand_rules.mjs` fails it before it ships. Motion is shared, not
app-only, because the website's component CSS reads it.

**Radius names mean one size each.** The design system's `radius-md` is 4px (controls), and
here it keeps that name and that value: code ported from the handover reads `var(--radius-md)`
and gets 4px. The app's ladder has names of its own, so no name means two sizes:

| Token | px | Where | Workspace utility |
|---|---|---|---|
| `radius-none` | 0 | website: images, cards, fields, sections; app: list rows | – |
| `radius-md` | 4 | website: buttons, gallery controls, AI tag, play button | – |
| `radius-inline` | 4 | app: kbd, checkbox, a tag inside a field | `rounded-inline` (Tailwind `rounded-sm`) |
| `radius-control` | 6 | app: buttons, fields, selects, tabs, menu and list items | `rounded-control` (`rounded-md`) |
| `radius-surface` | 10 | app: cards, panels, list containers, toasts, tables, code blocks | `rounded-surface` (`rounded-lg`) |
| `radius-overlay` | 14 | app: dialogs, popovers, menus, sheets, command palette | `rounded-overlay` (`rounded-xl`) |
| `radius-bubble` | 18 | app: chat messages and the composer | `rounded-bubble` |
| `radius-full` | 9999 | app: chips, badges, counts, avatars, dots, switches | `rounded-full` |

Until 2026-10-29 the package called 4px `radius-sm` and gave `radius-md` the app's 6px. That
was a trap: the same name meant 4px in the handover and 6px here, and nothing failed when a
rule ported from the handover picked it up. From the old names: `radius-sm` → `radius-md`
(website) or `radius-inline` (app); old `radius-md` → `radius-control`; `radius-lg` →
`radius-surface`; `radius-xl` → `radius-overlay`.

## Workflow

1. Edit `tokens.json`, `identity.json` or `css/components.css`.
2. `node packages/brand/build-tokens.mjs`, which regenerates `dist/`.
3. `node packages/brand/sync.mjs`, which writes the app copies.
4. `node packages/brand/sync.mjs --check` must exit 0. CI runs it.

Add a target by adding its directory to `TARGETS` in `sync.mjs`.

## Rules the package carries

- **Brand strings are copy.** They come from `identity.json`, never typed into code, class names or tokens. A rename edits `identity.json` and runs `sync.mjs`; `tests/test_product_name_parity.py` runs that drill on a scratch copy.
- **Names are English and brand-free.** Class names, tokens, files and component names never carry the product name. `ui-button`, `ColorUsage`, `--ink`.
- **Tokens are the only values.** No colour, size, space or radius outside the tokens. Spacing comes from the `--space-*` scale (4px base). Component-internal measures the handover fixes in px and the scale has no step for (20px row padding, 28px form gap, 40px card padding, 56px and 80px post gaps, 9px button padding) stay literal, as in the handover's own CSS; a value the scale has is written as its token.
- **Edit a token, not a copy.** `dist/` and the app copies are generated; the header of `tokens.css` says so.

## Design rules (summary)

Full text: the component sheets in `docs/components/`.

**Colour**

- White (`--surface`, #fafaf9) carries the page; black (`--ink`, #0f0e0d) carries the content and the one action. Neither is pure #ffffff or #000000.
- One light grey, `--surface-sunken` (#f2f1f0), marks bands. At most two bands per page, never next to each other.
- Rough share: 75 % white, 12 % light grey, 10 % black or dark, 3 % dark grey.
- No signal colours. `--markup` (red pen) appears only inside product screenshots.
- No shadows and no gradients on the website. The only blur is the glass header. The app uses three faint shadows (app scope: `shadow-raised` for what lies on a surface, `shadow-floating` for menus, popovers and toasts, `shadow-modal` for dialogs and sheets), read globally through the app's shadow utilities and never typed in a component.
- Dark theme (`data-theme="dark"`) is for the footer and at most one dark card per page.

**Buttons and actions**

- One primary (black-fill) button per area. Everything else is secondary (outline) or text.
- Hover is a colour step, not a shadow. Keyboard focus uses `--focus-ring`.

**Typography**

- General Sans, weight 500 for all content. Weight 420 only for the navigation and the small header buttons.
- The logo is the only element in capitals, set in Switzer Semibold.
- Hierarchy comes from size. Headings have generous line height, about 1.1; body about 1.4 to 1.5.
- Tracking is never tighter than 0, except the logo.
- Left-aligned, except large opening statements and the hero text (right-aligned).
- Mobile (below 768px) steps the display and heading sizes down; the component sheets give the numbers.

**Layout and shape**

- Two widths: content in a 1280px container with 32px margins; header and hero image full width with 64px margins. Mobile margins are 16px.
- The website stays crisp: controls 4px (`radius-md`), images, cards, fields and sections square. The app has its own ladder ([Two layers](#two-layers-website-and-app)): the same kind of element always takes the same step; a radius inside another is the outer one minus the padding between them.
- Lines only where they carry a function: field borders, underlines, FAQ and info list dividers, the timeline. No line between sections, and none under the header, also not while scrolling.
- Motion is quiet and architectural: things arrive and come to rest, nothing bounces. Tokens `--duration-*`, `--ease-settle`/`--ease-draft`, `--stagger-row`, `--travel-sm` (the vocabulary of `docs/ux/motion.md`); hover is `--duration-quick` (200ms) `ease-out`, the gallery 400ms, the duo cards 450ms, as handed over. Added beyond the handover, on purpose: a block below the fold arrives once on scroll (`data-reveal`, 8px, 480ms), an FAQ answer opens by height, the mobile menu settles in. Nothing on screen at load moves; with `prefers-reduced-motion` none of it runs and the still page is complete.

**Imagery**

- Real rooms, real people, product cut-outs on exactly `--surface-sunken`. No device mock-ups, no icons, no stock holograms.
- AI-generated images carry the `AITag` mark, bottom right.
- Pilot-office logos are grey, in `--line-strong`.

**German copy** (the product's public voice; the full voice, values and antonyms: [`docs/brand-basis.md`](docs/brand-basis.md))

- Address people with "Sie". Gender with a colon: "Planer:innen".
- Short, plain sentences. Planning language, not AI jargon: say "Modell", "Planstand", "Baurecht", not "LLM", "Agent", "Reasoning".
- ARCHOS is a Workspace or a Plattform, never a tool or a copilot, never a "KI-Workspace". The name is set in capitals and without ™, and in code it is always `{name}` from `identity.json`.
- Statement headings end with a full stop ("Kontakt."). Questions end with a question mark. Item labels in a grid or list (heading-3: "Hosting in Wien") take none, as in the reference.
- No exclamation marks, no emoji. Buttons start with the verb ("Demo anfragen").
- Be precise rather than absolute: promise only what the system does. Every number has a source (Belegpflicht). Name no certificate that does not exist.

## Rules the checks hold

A rule a person has to remember fails on a tired day. These are held by a machine; the rest
is review.

| Rule | Held by |
|---|---|
| App copies match the package; each app carries only its layer | `node packages/brand/sync.mjs --check` (website `bun run check`, CI) |
| No colour literal (hex, `rgb()`, `hsl()`) in the website's CSS, its `.astro` styles or `components.css` | `scripts/check_brand_rules.mjs` |
| No shadow on the website except `--focus-ring` | same |
| No app-only token on the website; every `var(--radius-*)`, `--space-*`, `--shadow-*` … the website reads exists in its token copy | same |
| German copy: no exclamation mark | same, over every string in `apps/website/src/i18n` |
| No emoji or pictograph, no ™, the name never typed (always `{name}`) | same |
| Not "Copilot", "KI-Workspace", "KI-Tool", "LLM", "Reasoning-Modell", "revolutioniert", "nahtlos", "generatives Design", "alles ab" … (the list and each reason: `BANNED_TERMS`) | same |
| Statement headings end with a full stop | same (keys `title`/`heading` of a section) |
| AI-generated images carry the `AITag` in their frame | same, over the built pages (`AI_GENERATED_MEDIA`) |
| Class names, files and tokens carry no brand name | `scripts/check_brand_names.py` (`task lint:repo`) |

`bun run check` in `apps/website` runs all of these; the AI-tag rule reads `dist/`, so
`task website:verify` runs the check once more after `bun run build` with `--require-build`.
The rule functions are pinned by `scripts/check_brand_rules.test.mjs`.

## Where this package deviates from the handover, and why

The handover (design system 3.0) is the reference; these are the recorded differences.

| What | Handover | Here | Why |
|---|---|---|---|
| Radius names | `radius-md` 4px | `radius-md` 4px; the app's ladder under names of its own | 4px renamed to `radius-sm` was a trap (above) |
| App layer | none | app-scoped shadows and radius ladder, in the app's copy only | The workspace's softer level is chosen by the owner |
| Motion | hover, gallery, duo | plus reveal on scroll, FAQ height, mobile menu, as tokens | Quiet arrival; off with reduced motion |
| Line under the header | none | none (a scroll hairline was removed on 2026-10-29) | Handover: "Keine Trennlinien … auch nicht unter dem Header" |
| CTA field on a phone | README: buttons side by side; reference site: they share the width and wrap | as the reference: side by side from about 400px, stacked full width at 390px and 360px | The reference site decides (`datensicherheit.html`, measured at 390 and 360); the port had forced a column at every phone width |
| Hero title on a phone | `display-xl` 44/46, hero sheet 40/44 | 40/44, shrinking with the viewport below 385px | The hero sheet and the reference site are the specific rule; „Architekturbüros.“ must fit 360px |
| Split note colours | hex literals | dark-theme tokens (`data-theme="dark"`), same values | Colours only through tokens |
| Tap targets on a phone | 34px controls | 44px for header buttons, footer, filter and split-page links | WCAG target size; nothing changes above 767px |
| Duo cards on a phone | min-height 0, body 360px | min-height 440px, body 390px | The handover's own README and the reference site |
| Video play button on a phone | 56px | 48px | Proportion on a 390px screen |
| Demo logos | page class `demo-logos` | `ui-split-logos`, part of `SplitPage` | Component classes carry the `ui-` prefix |

## Contrast of the line tokens

Measured against WCAG 2.2 (1.4.11 asks 3:1 for the border of a UI component): `--line-strong` is #8a8784 on paper #fafaf9 at 3.42:1 and on the sunken surface at 3.17:1, and #75726e on the dark surface at 4.03:1. It passes, so field borders keep the design system's look and no token changed. `--line` (#e7e5e3) is a divider, not a component border.

## Logo file names

The client logos were renamed from German to English when copied. The mapping:

| Was | Now |
|---|---|
| `Pilotbuero_bewe-emp.svg` | `pilot-office-bewe-emp.svg` |
| `Pilotbuero_feld72.svg` | `pilot-office-feld72.svg` |
| `Pilotbuero_ZZ-architecture.svg` | `pilot-office-zz-architecture.svg` |
| `Pilotbuero_Gerner-Gerner-Plus.svg` | `pilot-office-gerner-gerner-plus.svg` |
| `Foerderung_aws_grau.png` | `funding-aws-gray.png` |

## Not here yet

- The brand video (WebM and MP4 with poster) is too large for the package. It lives with `apps/website`.
- Full-resolution photographs are kept outside the repository.
- A vector logo file does not exist yet; the wordmark is text in Switzer.

## AuthKit

`authkit/authkit.css` is the hosted sign-in page in this design. WorkOS cannot read `tokens.css`, so it carries the literals; paste it into an environment's branding as global custom CSS (or set `customCssElements.authkitGlobal` through the WorkOS API). Run `node packages/brand/authkit/build.mjs` and paste `dist/authkit.css`. It needs the TwoColumn sign-in layout with the content panel on the right and custom HTML `<div class="panel-photo"></div>`. Staging has it; Production gets it at the rebrand. AuthKit loads only Google Fonts, so the type falls back to system sans there.
