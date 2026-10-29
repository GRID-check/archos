/**
 * The contact and demo forms hand their content to the visitor's mail program
 * (owner decision: mailto now, a CRM later; README, "Forms"). This builds that
 * hand-off: a `mailto:` URL whose subject and body are filled from the form, so
 * the mail arrives readable instead of as `name=...&email=...`.
 *
 * Pure, so the spec can hold the encoding: spaces must be `%20`, not `+`
 * (mail programs print a `+` literally), and line breaks `%0D%0A` (RFC 6068).
 */

/** One line of the mail body: the field's label and what the visitor entered. */
export interface MailLine {
  label: string;
  value: string;
}

/** RFC 6068 wants CRLF line breaks; encodeURIComponent writes spaces as %20. */
function encode(text: string): string {
  return encodeURIComponent(text.replace(/\r?\n/g, '\r\n'));
}

/**
 * The mail body: one `Label: value` line per filled field, then the free text
 * (the message), separated by a blank line. Empty fields are left out.
 */
export function mailBody(lines: MailLine[], message?: string): string {
  const head = lines
    .filter((line) => line.value.trim() !== '')
    .map((line) => `${line.label}: ${line.value.trim()}`)
    .join('\n');
  const text = message?.trim() ?? '';
  return [head, text].filter((part) => part !== '').join('\n\n');
}

/** `mailto:<to>?subject=…&body=…` */
export function mailtoHref(to: string, subject: string, body: string): string {
  return `mailto:${to}?subject=${encode(subject)}&body=${encode(body)}`;
}

/** Fills `{key}` tokens in a subject template with form values; unknown tokens stay. */
export function fillSubject(template: string, values: Record<string, string>): string {
  return template
    .replace(/\{(\w+)\}/g, (token, key: string) => (values[key]?.trim() ? values[key].trim() : token))
    .replace(/\s*\{\w+\}/g, '')
    .trim();
}
