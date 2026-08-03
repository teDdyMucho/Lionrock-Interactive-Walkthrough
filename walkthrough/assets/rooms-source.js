/* Supplies the shared walkthrough page with its rooms.
 *
 * The per-project pages read a static content/rooms.json. This one builds the
 * same shape from Supabase, so any property uploaded through the modal gets a
 * working walkthrough without needing its own folder in the repo.
 *
 * Returns: { property: {...}, rooms: [{ label, video }] }
 * — exactly what buildRoomsMeta()/applyPropertyChrome() in main.js expect.
 */

async function loadRoomsFromSupabase() {
  const slug = new URLSearchParams(location.search).get('property');
  if (!slug) throw new WalkthroughError('No property specified.');

  const cfg = window.SUPABASE_CONFIG || {};
  const ready =
    cfg.url && cfg.anonKey &&
    !cfg.url.includes('YOUR-PROJECT-REF') &&
    !cfg.anonKey.includes('YOUR-ANON');

  if (!ready) {
    throw new WalkthroughError(
      'Supabase isn\'t configured. Run `npm run config` after filling in .env.'
    );
  }

  const db = window.supabase.createClient(cfg.url, cfg.anonKey);

  const { data: property, error: pErr } = await db
    .from('properties')
    .select('id, slug, title, address')
    .eq('slug', slug)
    .maybeSingle();

  if (pErr) throw new WalkthroughError(`Couldn't load this property: ${pErr.message}`);
  if (!property) throw new WalkthroughError(`No property found for "${slug}".`);

  const { data: rows, error: vErr } = await db
    .from('property_videos')
    .select('area, label, video_url, sort_order')
    .eq('property_id', property.id)
    .order('sort_order');

  if (vErr) throw new WalkthroughError(`Couldn't load the rooms: ${vErr.message}`);

  const withVideo = (rows || []).filter((r) => r.video_url);

  // The intro isn't a room — it plays first and is where the timeline loops
  // back to, but gets no nav link or dot.
  const intro = withVideo.find((r) => r.area === 'intro');
  const usable = withVideo.filter((r) => r.area !== 'intro');
  if (!usable.length) {
    throw new WalkthroughError(
      `"${property.title}" doesn't have any videos yet. Upload some from the gallery.`
    );
  }

  return {
    property: {
      brand: 'Lion Rock',
      logoLink: '/',
      title: property.title,
      address: property.address || '',
      eyebrow: 'Virtual Walkthrough',
      // Only set when a real Intro clip was uploaded. buildRoomsMeta() prepends
      // a hidden "intro" room for this, so pointing it at Exterior (as it used
      // to) made Exterior play twice before Living. Without an intro the
      // walkthrough simply opens on Exterior.
      introVideo: intro ? intro.video_url : null,
      // The loader always wants something behind it. Falls back to the first
      // room, but purely as a backdrop — never as a room on the timeline.
      loaderVideo: (intro || usable[0]).video_url,
      footerNote:
        'This is a Virtual Stage of the Advertized Unit. Actual lighting, ' +
        'colors, and ambiance may vary on different screen.',
    },
    rooms: usable.map((r) => ({ label: r.label, video: r.video_url })),
  };
}

/* Distinguishes "expected, explainable" failures from real crashes so the page
   can show a readable message instead of hanging on the loader forever. */
class WalkthroughError extends Error {}
window.WalkthroughError = WalkthroughError;
window.loadRoomsFromSupabase = loadRoomsFromSupabase;
