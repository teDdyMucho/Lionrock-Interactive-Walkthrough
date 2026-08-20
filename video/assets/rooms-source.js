/* Supplies the Video Walkthrough with its rooms.
 *
 * Same properties and areas as the Interactive walkthrough.
 *
 * Returns: { property, rooms: [{ label, video }] }
 */

async function loadVideoRooms() {
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
    .select('area, label, video_url, reverse_url, sort_order')
    .eq('property_id', property.id)
    .order('sort_order');

  if (vErr) throw new WalkthroughError(`Couldn't load the rooms: ${vErr.message}`);

  const withVideo = (rows || []).filter((r) => r.video_url);
  const intro = withVideo.find((r) => r.area === 'intro');
  const usable = withVideo.filter((r) => r.area !== 'intro');

  if (!usable.length) {
    throw new WalkthroughError(
      `"${property.title}" doesn't have any videos yet. Upload some from the gallery.`
    );
  }

  return {
    property: {
      title: property.title,
      address: property.address || '',
      // No loaderVideo: this player's download screen is deliberately black,
      // so nothing of the walkthrough is shown before it's ready.
      footerNote:
        'This is a Virtual Stage of the Advertized Unit. Actual lighting, ' +
        'colors, and ambiance may vary on different screen.',
    },
    // The intro is not a room: it plays once on arrival and gets no nav entry
    // or dot. Passed separately so the player can show it before room 1.
    introVideo: intro ? intro.video_url : null,
    // `reverse` is the pre-rendered backwards clip, played when the viewer
    // moves to an EARLIER room — no browser can play a <video> backwards.
    rooms: usable.map((r) => ({
      label: r.label,
      video: r.video_url,
      reverse: r.reverse_url || null,
    })),
  };
}

class WalkthroughError extends Error {}
window.WalkthroughError = WalkthroughError;
window.loadVideoRooms = loadVideoRooms;
