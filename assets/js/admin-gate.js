/* Shows the gallery's admin controls (Upload/Edit, Sign out) only to a
 * signed-in admin.
 *
 * Both buttons start hidden in CSS, so a visitor never sees them flash.
 * Signing in happens at /manage/; the session is shared, so this picks it up
 * automatically — including in another tab, via onChange.
 *
 * This is the UI half of the boundary. The database half is migration 002,
 * which makes Supabase reject writes from anyone who isn't authenticated.
 */

(function () {
  const uploadBtn = document.getElementById('upload-btn');
  const signOutBtn = document.getElementById('signout-btn');
  const apiDocsBtn = document.getElementById('apidocs-btn');
  if (!window.AdminAuth) return;

  const apply = (user) => {
    if (uploadBtn) uploadBtn.classList.toggle('signed-in', !!user);
    if (signOutBtn) signOutBtn.classList.toggle('signed-in', !!user);
    if (apiDocsBtn) apiDocsBtn.classList.toggle('signed-in', !!user);

    // Closing the modal on sign-out avoids leaving an editing surface open.
    if (!user) {
      const modal = document.getElementById('upload-modal');
      if (modal) modal.classList.remove('open');
    }
  };

  window.AdminAuth.getUser().then(apply);
  window.AdminAuth.onChange(apply);

  /* Signing out is easy to hit by accident and costs a re-login, so it asks
     first rather than acting on the click. */
  const confirmPanel = document.getElementById('signout-confirm');
  const confirmYes = document.getElementById('signout-yes');
  const confirmNo = document.getElementById('signout-cancel');

  const openConfirm = () => confirmPanel && confirmPanel.classList.add('show');
  const closeConfirm = () => confirmPanel && confirmPanel.classList.remove('show');

  if (signOutBtn) {
    signOutBtn.addEventListener('click', () => {
      if (confirmPanel) openConfirm();
      else doSignOut(); // no modal in the DOM — don't strand the button
    });
  }

  if (confirmNo) confirmNo.addEventListener('click', closeConfirm);

  // Clicking the backdrop or pressing Escape cancels — same as Cancel.
  if (confirmPanel) {
    confirmPanel.addEventListener('click', (e) => {
      if (e.target === confirmPanel) closeConfirm();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && confirmPanel && confirmPanel.classList.contains('show')) {
      closeConfirm();
    }
  });

  if (confirmYes) confirmYes.addEventListener('click', doSignOut);

  async function doSignOut() {
    if (confirmYes) confirmYes.disabled = true;
    if (signOutBtn) signOutBtn.disabled = true;
    await window.AdminAuth.signOut();
    // Back to the login page. replace() so Back doesn't return to a gallery
    // that's still showing admin controls from the old session. The flag
    // stops /manage/ redirecting straight back if the session read is stale.
    location.replace('/manage/?signedout=1');
  }
})();
