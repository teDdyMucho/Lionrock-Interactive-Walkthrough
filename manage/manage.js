/* Sign-in screen for /manage/.
 *
 * There is no signed-in view: a successful sign-in (or arriving with a session
 * already active) goes straight to the gallery, where the Upload/Edit button is
 * now visible.
 */

(function () {
  const $ = (sel) => document.querySelector(sel);

  const status = $('#login-status');

  const setStatus = (msg, isError) => {
    status.textContent = msg || '';
    status.classList.toggle('error', !!isError);
  };

  const goToGallery = () => { location.replace('/'); };

  if (!window.AdminAuth || !window.AdminAuth.available) {
    setStatus(
      'Supabase isn\'t configured on this deployment. Set SUPABASE_URL and ' +
      'SUPABASE_ANON_KEY, and make sure the build runs `npm run config`.',
      true
    );
    $('#login-btn').disabled = true;
    return;
  }

  // Already signed in (session persists) — don't make them look at a login form.
  //
  // ?signedout=1 suppresses this: arriving straight from the Sign out button,
  // the local session can still be readable for a moment, and redirecting on it
  // would bounce the user back to the gallery they just left.
  const justSignedOut = new URLSearchParams(location.search).has('signedout');

  if (justSignedOut) {
    setStatus('Signed out.', false);
    // Clean the URL so a later refresh behaves normally.
    history.replaceState(null, '', '/manage/');
  } else {
    window.AdminAuth.getUser().then((user) => {
      if (user) goToGallery();
    });
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = $('#email').value.trim();
    const password = $('#password').value;
    if (!email || !password) return;

    $('#login-btn').disabled = true;
    setStatus('Signing in…', false);

    try {
      await window.AdminAuth.signIn(email, password);
      goToGallery();
    } catch (err) {
      setStatus(window.AdminAuth.explainAuthError(err), true);
      $('#login-btn').disabled = false;
    }
  });
})();
