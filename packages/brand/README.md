# packages/brand: the corporate design

The one source for how the product looks and what it says in its public copy. The
website and the workspace UI read committed copies of the built files, so a token
or a brand string changes here and reaches every surface on the next sync.

## Layout

| Path | What it is |
|---|---|
| `tokens.json` | **Source of truth** for colours, type, spacing, radii, strokes, layout. Every token carries its `usage` in German. |
| `identity.json` | Every brand string: name, claim, legal entity, address, e-mail, domain, hosting city. |
| `css/components.css` | Hand-maintained component classes (prefix `ui-`). Values come from the tokens. |
| `fonts/` | The two WOFF2 files (General Sans variable, Switzer Semibold). |
| `assets/logos/` | Client logos in grey (Pilotbüros, funding logo). The brand video is not here; it lives with the website. |
| `docs/components/` | One Markdown rules sheet per component, plus `ColorUsage.md`. |
| `build-tokens.mjs` | Builds `dist/tokens.css` and `dist/tokens.vars.css` from `tokens.json` and copies `css/` and `fonts/` into `dist/`. `tokens.vars.css` is the colours, shadows and scalars as variables only, prefixed `--ds-`, dark under `.dark` too: an app with token names of its own (the workspace) imports it and maps its names onto it rather than typing a value. |
| `sync.mjs` | Copies `dist/` and `identity.json` into each app in `TARGETS`. `--check` writes nothing and fails on drift. |
| `dist/` | Built output, committed on purpose (see the root `.gitignore` negation). |
| `mark.svg`, `build-brand-assets.mjs` | The app icon master and its raster build. Unrelated to the tokens. |

Apps receive copies, not imports: neither Docker build sees `packages/`.

- `apps/website/src/styles/brand/`
- `apps/workspace/shared/brand/`

## Workflow

1. Edit `tokens.json`, `identity.json` or `css/components.css`.
2. `node packages/brand/build-tokens.mjs`, which regenerates `dist/`.
3. `node packages/brand/sync.mjs`, which writes the app copies.
4. `node packages/brand/sync.mjs --check` must exit 0. CI runs it.

Add a target by adding its directory to `TARGETS` in `sync.mjs`.

## Rules the package carries

- **Brand strings are copy.** They come from `identity.json`, never typed into code, class names or tokens.
- **Names are English and brand-free.** Class names, tokens, files and component names never carry the product name. `ui-button`, `ColorUsage`, `--ink`.
- **Tokens are the only values.** No colour, size, space or radius outside the tokens. Spacing comes only from the `--space-*` scale (4px base).
- **Edit a token, not a copy.** `dist/` and the app copies are generated; the header of `tokens.css` says so.

## Design rules (summary)

Full text: the component sheets in `docs/components/`.

**Colour**

- White (`--surface`, #fafaf9) carries the page; black (`--ink`, #0f0e0d) carries the content and the one action. Neither is pure #ffffff or #000000.
- One light grey, `--surface-sunken` (#f2f1f0), marks bands. At most two bands per page, never next to each other.
- Rough share: 75 % white, 12 % light grey, 10 % black or dark, 3 % dark grey.
- No signal colours. `--markup` (red pen) appears only inside product screenshots.
- No shadows and no gradients on the website. The only blur is the glass header. The app uses three faint shadows from `tokens.json` (`shadow-raised` for what lies on a surface, `shadow-floating` for menus, popovers and toasts, `shadow-modal` for dialogs and sheets), read globally through the app's shadow utilities and never typed in a component.
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
- Radius follows size and shape, one ladder in `tokens.json`. The website stays crisp: controls 4px (`radius-sm`), images, cards, fields and sections square. The app uses the whole ladder: small inline things `radius-sm` (4px), controls `radius-md` (6px), surfaces `radius-lg` (10px), floating layers (dialogs, popovers, menus, sheets) `radius-xl` (14px), chat messages and the composer `radius-bubble` (18px), and what is naturally round (chips, badges, counts, avatars, dots, switches) `radius-full`. The same kind of element always takes the same step; a radius inside another is the outer one minus the padding between them.
- Lines only where they carry a function: field borders, underlines, FAQ and info list dividers.
- Motion is quiet and architectural: things arrive and come to rest, nothing bounces. Tokens `--duration-*`, `--ease-settle`/`--ease-draft`, `--stagger-row`, `--travel-sm` (the vocabulary of `docs/ux/motion.md`); hover stays 200ms `ease-out`. What moves: a block below the fold arrives once on scroll (`data-reveal`, 8px, 480ms), the header's hairline fades in when the page passes beneath it, an FAQ answer opens by height, the mobile menu settles in. Nothing on screen at load moves; with `prefers-reduced-motion` none of it runs and the still page is complete.

**Imagery**

- Real rooms, real people, product cut-outs on exactly `--surface-sunken`. No device mock-ups, no icons, no stock holograms.
- AI-generated images carry the `AITag` mark, bottom right.
- Pilot-office logos are grey, in `--line-strong`.

**German copy** (the product's public voice)

- Address people with "Sie". Gender with a colon: "Planer:innen".
- Short, plain sentences. Planning language, not AI jargon: say "Modell", "Planstand", "Baurecht", not "LLM", "Agent", "Reasoning".
- Headings end with a full stop ("Kontakt."). Questions end with a question mark.
- No exclamation marks, no emoji. Buttons start with the verb ("Demo anfragen").
- Be precise rather than absolute: promise only what the system does. Name no certificate that does not exist.

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
