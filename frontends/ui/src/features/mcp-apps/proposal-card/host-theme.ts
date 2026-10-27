/**
 * Piloti's design tokens in the host's theme (ADR-0142, "The host theming map").
 *
 * An MCP Apps host passes its own CSS variables in `hostContext.styles`
 * (MCP Apps 2026-01-26, "Theming": `--color-background-primary`,
 * `--color-text-secondary`, `--font-sans`, `--border-radius-md`, …), any subset
 * of them or none. The card keeps Piloti's components and layout, and takes the
 * host's colours, type and radius where the host gives them, so it reads as
 * part of the conversation it sits in. A token the host does not give keeps
 * Piloti's value (`tokens.css`): a host that passes nothing gets Piloti's card.
 *
 * Two steps, both on the document root:
 *
 *  1. The host's variables are set as given (`applyHostStyleVariables`, the
 *     SDK's). `--font-sans`, `--font-weight-*` and `--shadow-*` share their
 *     names with Piloti's theme, so those take the host's value directly.
 *  2. Each Piloti token in {@link HOST_TOKEN_MAP} whose host variable is set
 *     becomes `var(<host variable>)`. The host's value is never copied, so a
 *     `light-dark()` value keeps following the theme.
 *
 * The theme itself (`hostContext.theme`) is Piloti's `.dark` class (the
 * `dark:` variant, `globals.css`) and the SDK's `data-theme` and
 * `color-scheme` (`applyDocumentTheme`), so a host's `light-dark()` values and
 * Piloti's dark tokens agree.
 */

import {
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
  type McpUiStyleVariableKey,
} from '@modelcontextprotocol/ext-apps/react-with-deps'

/**
 * Piloti's token, and the host variable it takes when the host gives one. Read
 * left to right: the card's surface is the host's primary background, its
 * quiet text the host's secondary text, its one action (ink, ADR "no accent
 * on actions") the host's inverse background.
 */
export const HOST_TOKEN_MAP = {
  '--background': '--color-background-primary',
  '--card': '--color-background-primary',
  '--popover': '--color-background-primary',
  '--foreground': '--color-text-primary',
  '--card-foreground': '--color-text-primary',
  '--popover-foreground': '--color-text-primary',
  '--muted': '--color-background-secondary',
  '--secondary': '--color-background-secondary',
  '--accent': '--color-background-tertiary',
  '--muted-foreground': '--color-text-secondary',
  '--secondary-foreground': '--color-text-primary',
  '--accent-foreground': '--color-text-primary',
  '--primary': '--color-background-inverse',
  '--primary-foreground': '--color-text-inverse',
  '--destructive': '--color-text-danger',
  '--border': '--color-border-primary',
  '--input': '--color-border-secondary',
  '--ring': '--color-ring-primary',
  '--radius': '--border-radius-lg',
  // The legacy semantic names the atoms still read (`text-subtle`, `border-l-subtle`, `bg-surface-*`).
  '--text-color-subtle': '--color-text-tertiary',
  '--text-color-secondary': '--color-text-secondary',
  '--border-color-base': '--color-border-primary',
  '--background-color-surface-base': '--color-background-primary',
  '--background-color-surface-raised': '--color-background-secondary',
  '--background-color-surface-sunken': '--color-background-secondary',
} as const satisfies Record<`--${string}`, McpUiStyleVariableKey>

export type PilotiToken = keyof typeof HOST_TOKEN_MAP

/** The `var()` each Piloti token takes from what the host gave: only the ones it gave. */
export function hostTokenOverrides(variables: Readonly<Partial<Record<string, string | undefined>>>): Partial<Record<PilotiToken, string>> {
  const overrides: Partial<Record<PilotiToken, string>> = {}
  for (const [token, hostVariable] of Object.entries(HOST_TOKEN_MAP) as [PilotiToken, McpUiStyleVariableKey][]) {
    const given = variables[hostVariable]
    if (typeof given === 'string' && given.trim() !== '') overrides[token] = `var(${hostVariable})`
  }
  return overrides
}

/** Everything the host context says about looks, applied to `root` (the document's, by default). */
export function applyHostTheme(context: McpUiHostContext | undefined, root: HTMLElement = document.documentElement): void {
  if (!context) return
  if (context.theme) {
    applyDocumentTheme(context.theme)
    root.classList.toggle('dark', context.theme === 'dark')
  }
  const styles = context.styles
  if (styles?.variables) {
    applyHostStyleVariables(styles.variables, root)
    // A token the host stopped giving goes back to Piloti's own value.
    const overrides = hostTokenOverrides(styles.variables)
    for (const token of Object.keys(HOST_TOKEN_MAP) as PilotiToken[]) {
      const value = overrides[token]
      if (value) root.style.setProperty(token, value)
      else root.style.removeProperty(token)
    }
  }
  if (styles?.css?.fonts) applyHostFonts(styles.css.fonts)
}
