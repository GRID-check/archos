/** A label and its target: header, footer and page actions share this shape. */
export interface NavLink {
  label: string;
  href: string;
}

/** Main navigation of the header, in order. */
export const mainNav: NavLink[] = [
  { label: 'Plattform', href: '/' },
  { label: 'Datensicherheit', href: '/datensicherheit' },
  { label: 'Blog', href: '/blog' },
];

export const loginLink: NavLink = { label: 'Login', href: '/login' };
export const demoLink: NavLink = { label: 'Demo anfragen', href: '/demo' };

/** Footer link columns. The reference's third column (LinkedIn, Kontakt) is replaced by the legal row. */
export const footerColumns: { title: string; links: NavLink[] }[] = [
  { title: 'Produkt', links: [{ label: 'Plattform', href: '/' }] },
  { title: 'Wissen', links: [{ label: 'Blog', href: '/blog' }] },
];

export const legalLinks: NavLink[] = [
  { label: 'Impressum', href: '/impressum' },
  { label: 'Datenschutz', href: '/datenschutz' },
  { label: 'Kontakt', href: '/kontakt' },
];
