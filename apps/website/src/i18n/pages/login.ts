/**
 * Copy of the login page, both locales. `{name}` is the brand name, filled by
 * `withName`. Text, alt text and labels only: the image, the form's field names
 * and the sign-in target live in `src/views/LoginView.astro`.
 */
const de = {
  title: 'Anmelden',
  description: 'Anmelden bei {name}.',
  imageAlt: 'Leeres Planungsbüro im Abendlicht: Holztisch mit Planrollen und Laptop, Stuhl, Fensterlicht an der Wand',
  heading: 'Anmelden.',
  welcome: 'Willkommen zurück bei {name}.',
  microsoft: 'Mit Microsoft anmelden',
  google: 'Mit Google anmelden',
  or: 'oder',
  emailLabel: 'E-Mail',
  emailPlaceholder: 'name@buero.at',
  submit: 'Weiter',
  linkNote: 'Sie erhalten einen Anmeldelink per E-Mail.',
  noAccess: 'Noch kein Zugang?',
  backToWebsite: 'Zur Website',
};

const en: typeof de = {
  title: 'Sign in',
  description: 'Sign in to {name}.',
  imageAlt: 'Empty planning office in evening light: wooden table with plan rolls and a laptop, a chair, window light on the wall',
  heading: 'Sign in.',
  welcome: 'Welcome back to {name}.',
  microsoft: 'Sign in with Microsoft',
  google: 'Sign in with Google',
  or: 'or',
  emailLabel: 'Email',
  emailPlaceholder: 'name@office.com',
  submit: 'Continue',
  linkNote: 'You will receive a sign-in link by email.',
  noAccess: 'No access yet?',
  backToWebsite: 'Back to website',
};

export default { de, en };
