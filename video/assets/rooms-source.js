/* Supplies the Video Walkthrough with its rooms.
 *
 * Same properties and areas as the Interactive walkthrough — this just also
 * reads `reverse_url`, the pre-rendered backwards clip that makes moving to an
 * earlier room possible without seeking.
 *
 * Returns: { property, rooms: [{ label, video, reverse }] }
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

  // reverse_url arrives with migration 005. Selecting it before that migration
  // has run would 400 the whole query, so fall back to forward-only rather
  // than breaking the page.
  let rows = null;
  let hasReverse = true;

  const full = await db
    .from('property_videos')
    .select('area, label, video_url, reverse_url, sort_order')
    .eq('property_id', property.id)
    .order('sort_order');

  if (full.error) {
    hasReverse = false;
    const basic = await db
      .from('property_videos')
      .select('area, label, video_url, sort_order')
      .eq('property_id', property.id)
      .order('sort_order');
    if (basic.error) throw new WalkthroughError(`Couldn't load the rooms: ${basic.error.message}`);
    rows = basic.data;
  } else {
    rows = full.data;
  }

  const withVideo = (rows || []).filter((r) => r.video_url);
  const intro = withVideo.find((r) => r.area === 'intro');
  const usable = withVideo.filter((r) => r.area !== 'intro');

  if (!usable.length) {
    throw new WalkthroughError(
      `"${property.title}" doesn't have any videos yet. Upload some from the gallery.`
    );
  }

  return {
    hasReverse,
    property: {
      title: property.title,
      address: property.address || '',
      loaderVideo: (intro || usable[0]).video_url,
      footerNote:
        'This is a Virtual Stage of the Advertized Unit. Actual lighting, ' +
        'colors, and ambiance may vary on different screen.',
    },
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
