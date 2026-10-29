/**
 * Old public addresses and where they live now: Astro's `redirects`, each a 301
 * (Astro's default is 308). An old address keeps the spelling it was published
 * under, product names included, because links and search results out in the
 * world still use it. That is why the brand-name check skips this file
 * (scripts/check_brand_names.py EXCLUDED, scripts/check_brand_prose.py HISTORY_PATHS);
 * new routes never carry a brand.
 *
 * The full table for the old site's URLs (route fates) is still to come; this
 * file is where it belongs.
 */
export const redirects = {
  // The old login pages forward to AuthKit's sign-in, which lists the enabled methods itself.
  '/login': { status: 301, destination: '/sign-in' },
  '/en/login': { status: 301, destination: '/sign-in' },
  // Blog posts whose slug carried the old product name.
  '/blog/willkommen-bei-piloti': { status: 301, destination: '/blog/willkommen/' },
  '/blog/wie-piloti-funktioniert': { status: 301, destination: '/blog/so-arbeitet-der-workspace/' },
  '/en/blog/welcome-to-piloti': { status: 301, destination: '/en/blog/welcome/' },
  '/en/blog/how-piloti-works': { status: 301, destination: '/en/blog/how-the-workspace-works/' },
}
