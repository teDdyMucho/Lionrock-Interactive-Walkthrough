/* Shared Supabase Auth helper.
 *
 * Used by /manage/ (the sign-in page) and by the gallery, which hides the
 * Upload/Edit button unless someone is signed in.
 *
 * Unlike a hardcoded password, this is a real boundary: the session is a signed
 * JWT issued by Supabase, and once migration 002 is applied the database itself
 * rejects writes from anyone who isn't authenticated. Hiding the button is then
 * just the UI half of it.
 *
 * supabase-js persists the session in localStorage and refreshes it, so signing
 * in on /manage/ carries over to the gallery in the same browser.
 */

(function () {
  const cfg = window.SUPABASE_CONFIG || {};
  const configured =
    cfg.url && cfg.anonKey &&
    !cfg.url.includes('YOUR-PROJECT-REF') &&
    !cfg.anonKey.includes('YOUR-ANON');

  // One shared client, so the session is consistent across every script on the
  // page (upload.js and gallery.js create their own for data reads).
  const client = configured
    ? window.supabase.createClient(cfg.url, cfg.anonKey)
    : null;

  async function getUser() {
    if (!client) return null;
    try {
      const { data } = await client.auth.getSession();
      return data && data.session ? data.session.user : null;
    } catch {
      return null;
    }
  }

  async function signIn(email, password) {
    if (!client) throw new Error('Supabase isn\'t configured on this deployment.');
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.user;
  }

  async function signOut() {
    if (!client) return;
    try { await client.auth.signOut(); } catch { /* already gone */ }
  }

  /* Fires whenever the session appears or disappears, including in another tab,
     so the gallery's Upload button follows sign-in/out without a reload. */
  function onChange(fn) {
    if (!client) return;
    client.auth.onAuthStateChange((_event, session) => {
      fn(session ? session.user : null);
    });
  }

  /* Turns Supabase's auth errors into something a person can act on. */
  function explainAuthError(err) {
    const msg = String((err && err.message) || err);

    if (/email not confirmed/i.test(msg)) {
      return 'That account still needs its email confirmed. Open the confirmation ' +
             'link Supabase emailed, or confirm the user in the Supabase dashboard ' +
             '(Authentication → Users).';
    }
    if (/invalid login credentials/i.test(msg)) {
      return 'Wrong email or password.';
    }
    if (/failed to fetch|network/i.test(msg)) {
      return 'Can\'t reach Supabase — check your connection.';
    }
    return msg;
  }

  window.AdminAuth = {
    available: !!client,
    client,
    getUser,
    signIn,
    signOut,
    onChange,
    explainAuthError,
  };
})();
