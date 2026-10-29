/** Joins the truthy class names; the design system's `cx` helper. */
export function joinClasses(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
