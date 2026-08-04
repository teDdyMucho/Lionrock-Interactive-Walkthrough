/* Shows the gallery's Upload/Edit button only to a signed-in admin.
 *
 * The button starts hidden in CSS, so a visitor never sees it flash. Signing in
 * happens at /manage/; the session is shared, so this picks it up automatically
 * — including in another tab, via onChange.
 *
 * This is the UI half of the boundary. The database half is migration 002,
 * which makes Supabase reject writes from anyone who isn't authenticated.
 */

(function () {
  const btn = document.getElementById('upload-btn');
  if (!btn || !window.AdminAuth) return;

  const apply = (user) => {
    btn.classList.toggle('signed-in', !!user);
    // Closing the modal on sign-out avoids leaving an editing surface open.
    if (!user) {
      const modal = document.getElementById('upload-modal');
      if (modal) modal.classList.remove('open');
    }
  };

  window.AdminAuth.getUser().then(apply);
  window.AdminAuth.onChange(apply);
})();
