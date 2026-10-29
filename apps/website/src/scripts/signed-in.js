// Runs in <head>, before the header paints: when the app says this browser has a
// session (its `signed_in` cookie on the parent domain, value always 1), the header
// shows "App öffnen" instead of "Login" (site.css). No cookie, no script: "Login".
if (/(?:^|;\s*)signed_in=1(?:;|$)/.test(document.cookie)) {
  document.documentElement.setAttribute('data-signed-in', '');
}
