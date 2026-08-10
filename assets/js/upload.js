/* Lion Rock — upload modal
 *
 * Two steps:
 *   1. "What property" — pick an existing property from Supabase, or add a new one
 *   2. The 7 room areas — one drop/pick slot each, uploaded to Storage
 *
 * Each finished upload writes a row into `property_videos` (upserted on
 * property_id + area, so re-uploading an area replaces it).
 */

/* The DEFAULT slots a brand-new property starts with. They're only a starting
   point — labels are editable, areas can be removed, and new ones added (see
   migration 004, which relaxed `area` from a fixed whitelist to a slug check).

   The intro is optional and isn't a room: it plays first and sits behind the
   loader, then the walkthrough continues into the first room. Leave it empty
   and the walkthrough just starts on room 1. */
const DEFAULT_AREAS = [
  { area: 'intro',     label: 'Intro',     intro: true },
  { area: 'exterior',  label: 'Exterior'  },
  { area: 'living',    label: 'Living'    },
  { area: 'dining',    label: 'Dining'    },
  { area: 'kitchen',   label: 'Kitchen'   },
  { area: 'bedroom-1', label: 'Bedroom 1' },
  { area: 'bathroom',  label: 'Bathroom'  },
  { area: 'bedroom-2', label: 'Bedroom 2' },
];

/* The live, editable slot list for the property being uploaded to. Rebuilt from
   DEFAULT_AREAS + whatever already exists in the DB each time step 2 opens. */
let areaRows = [];

const MAX_FILE_BYTES = 524288000; // 500MB — matches the bucket's file_size_limit

/* Which gallery tab the modal is operating on. Shares the key the gallery
   writes, so opening Upload/Edit always edits the tab you're looking at. */
function uploadMode() {
  try {
    return localStorage.getItem('lionrock-walkthrough-mode') === 'video'
      ? 'video'
      : 'interactive';
  } catch {
    return 'interactive';
  }
}

function uploadModeLabel() {
  return uploadMode() === 'video' ? 'Video Walkthrough' : 'Interactive Walkthrough';
}

const cfg = window.SUPABASE_CONFIG || {};
const configured =
  cfg.url && cfg.anonKey &&
  !cfg.url.includes('YOUR-PROJECT-REF') &&
  !cfg.anonKey.includes('YOUR-ANON');

/* Reuse AdminAuth's client so uploads carry the signed-in session. A separate
   client would send writes as anon, which migration 002 rejects. */
const db = window.AdminAuth && window.AdminAuth.client
  ? window.AdminAuth.client
  : (configured ? window.supabase.createClient(cfg.url, cfg.anonKey) : null);

/* selected file per area, keyed by area id */
const staged = new Map();
let properties = [];
let selectedPropertyId = null;

const $ = (sel) => document.querySelector(sel);

/* ---------- open / close ---------- */

function openModal() {
  $('#upload-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  const tag = $('#upload-mode-tag');
  if (tag) tag.textContent = uploadModeLabel();
  showStep(1);
  setPropertyStatus('', false);
  loadProperties();
}

function closeModal() {
  $('#upload-modal').classList.remove('open');
  document.body.style.overflow = '';
  staged.clear();
  selectedPropertyId = null;
  $('#new-property-form').classList.remove('open');
  // Areas are rebuilt per-property when step 2 opens, so just clear them.
  areaRows = [];
  $('#area-grid').innerHTML = '';
  $('#new-area-name').value = '';
}

function showStep(n) {
  $('#step-property').classList.toggle('active', n === 1);
  $('#step-areas').classList.toggle('active', n === 2);
}

/* ---------- step 1: what property ---------- */

async function loadProperties() {
  const list = $('#property-list');

  if (!db) {
    const local = ['localhost', '127.0.0.1', ''].includes(location.hostname);
    list.innerHTML = local
      ? '<p class="upload-note">Supabase isn\'t configured yet. Fill in <code>.env</code>, ' +
        'then run <code>npm run config</code>.</p>'
      : '<p class="upload-note">Supabase isn\'t configured on this deployment. Set ' +
        '<code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> in your host\'s ' +
        'environment variables, and set the build command to <code>npm run config</code>.</p>';
    return;
  }

  list.innerHTML = '<p class="upload-note">Loading properties…</p>';

  // Only this tab's properties — the two galleries are independent lists
  // (migration 006), so uploading is scoped to whichever tab is selected.
  const scoped = await db
    .from('properties')
    .select('id, slug, title, address, mode')
    .eq('mode', uploadMode())
    .order('title');

  let data = scoped.data;

  // Before migration 006 there's no `mode` column; show everything instead of
  // an empty picker.
  if (scoped.error) {
    const all = await db
      .from('properties')
      .select('id, slug, title, address')
      .order('title');
    if (all.error) {
      list.innerHTML = `<p class="upload-note error">Couldn't load properties: ${all.error.message}</p>`;
      return;
    }
    data = all.data;
  }

  properties = data || [];

  if (!properties.length) {
    list.innerHTML = '<p class="upload-note">No properties yet — add one below.</p>';
    return;
  }

  list.innerHTML = properties
    .map(
      (p) => `
      <div class="property-row">
        <button class="property-option" data-id="${p.id}">
          <span class="property-name">${escapeHtml(p.title)}</span>
          <span class="property-address">${escapeHtml(p.address || p.slug)}</span>
        </button>
        <button class="property-delete" data-id="${p.id}"
                title="Delete this unit" aria-label="Delete ${escapeHtml(p.title)}">&times;</button>
      </div>`
    )
    .join('');

  list.querySelectorAll('.property-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedPropertyId = btn.dataset.id;
      list.querySelectorAll('.property-option').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      $('#to-areas').disabled = false;
    });
  });

  list.querySelectorAll('.property-delete').forEach((btn) => {
    btn.addEventListener('click', () => deleteProperty(btn.dataset.id));
  });
}

/* Deletes a unit, its video rows, and its files in Storage.
   `property_videos` has ON DELETE CASCADE, so the rows go with the property —
   but Storage objects are not managed by Postgres and would be orphaned
   (still billed, still publicly reachable), so they're removed explicitly. */
async function deleteProperty(id) {
  const property = properties.find((p) => p.id === id);
  if (!property || !db) return;

  const typed = prompt(
    `Delete "${property.title}" and all of its videos?\n\n` +
    `This can't be undone. Type the unit name to confirm:`
  );
  if (typed === null) return;                       // cancelled
  if (typed.trim() !== property.title.trim()) {
    setPropertyStatus('Name didn\'t match — nothing was deleted.', true);
    return;
  }

  setPropertyStatus(`Deleting "${property.title}"…`, false);

  // Collect storage paths before the rows disappear.
  const { data: vids } = await db
    .from('property_videos')
    .select('storage_path')
    .eq('property_id', id);

  const paths = (vids || []).map((v) => v.storage_path).filter(Boolean);
  if (paths.length) {
    const { error: rmErr } = await db.storage
      .from(cfg.bucket || 'walkthrough-videos')
      .remove(paths);
    // A storage failure shouldn't block the delete — report it and continue,
    // otherwise the unit is stuck undeletable.
    if (rmErr) console.warn('Some video files could not be removed:', rmErr.message);
  }

  const { error } = await db.from('properties').delete().eq('id', id);
  if (error) {
    setPropertyStatus(explainError(error, 'delete the unit'), true);
    return;
  }

  if (selectedPropertyId === id) {
    selectedPropertyId = null;
    $('#to-areas').disabled = true;
  }

  await loadProperties();
  setPropertyStatus(`Deleted "${property.title}".`, false);
}

async function createProperty() {
  const title = $('#new-title').value.trim();
  const address = $('#new-address').value.trim();

  if (!title) {
    setPropertyStatus('Give the property a title first.', true);
    return;
  }
  if (!db) {
    setPropertyStatus('Supabase isn\'t configured — see the note above.', true);
    return;
  }

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  setPropertyStatus('Saving…', false);

  // New properties belong to whichever tab is currently selected.
  const insert = { slug, title, address, mode: uploadMode() };

  let { data, error } = await db
    .from('properties')
    .insert(insert)
    .select()
    .single();

  // Pre-migration-006 there's no `mode` column — retry without it.
  if (error && /mode/.test(error.message || '')) {
    ({ data, error } = await db
      .from('properties')
      .insert({ slug, title, address })
      .select()
      .single());
  }

  if (error) {
    setPropertyStatus(explainError(error, 'add the property'), true);
    return;
  }

  $('#new-title').value = '';
  $('#new-address').value = '';
  $('#new-property-form').classList.remove('open');
  setPropertyStatus(`Added "${data.title}".`, false);
  await loadProperties();

  // auto-select the one just created
  const btn = $(`.property-option[data-id="${data.id}"]`);
  if (btn) btn.click();
}

/* ---------- step 2: the 7 areas ---------- */

/* Builds the slot list for the selected property: the defaults, plus any area
   already in the DB (with its saved label), so renames and custom rooms persist
   between visits. */
async function buildAreaRows() {
  areaRows = DEFAULT_AREAS.map((d) => ({ ...d, existing: false, hasVideo: false }));

  if (!db || !selectedPropertyId) return;

  // reverse_url only exists once migration 005 has run; asking for it before
  // that 400s the whole query, so fall back to the forward-only shape.
  let data = null;
  const full = await db
    .from('property_videos')
    .select('area, label, video_url, reverse_url, storage_path, reverse_path, sort_order')
    .eq('property_id', selectedPropertyId)
    .order('sort_order');

  if (full.error) {
    const basic = await db
      .from('property_videos')
      .select('area, label, video_url, sort_order')
      .eq('property_id', selectedPropertyId)
      .order('sort_order');
    if (basic.error || !basic.data) return;
    data = basic.data;
  } else {
    data = full.data;
  }

  if (!data) return;

  data.forEach((row) => {
    const match = areaRows.find((r) => r.area === row.area);
    if (match) {
      match.label = row.label || match.label;   // saved rename wins
      match.existing = true;
      match.hasVideo = !!row.video_url;
      match.hasReverse = !!row.reverse_url;
      match.storagePath = row.storage_path || null;
      match.reversePath = row.reverse_path || null;
      match.savedSort = row.sort_order;
    } else {
      areaRows.push({
        area: row.area,
        label: row.label || row.area,
        intro: row.area === 'intro',
        existing: true,
        hasVideo: !!row.video_url,
        hasReverse: !!row.reverse_url,
        storagePath: row.storage_path || null,
        reversePath: row.reverse_path || null,
        savedSort: row.sort_order,
      });
    }
  });

  // Restore the saved order. Defaults with no row yet keep their listed
  // position, falling in after anything the DB has an explicit order for.
  // (Uses savedSort, not orderOf — orderOf reads array position, which is what
  // this sort is deciding.)
  areaRows.sort((a, b) => savedOrderOf(a) - savedOrderOf(b));
}

function savedOrderOf(row) {
  if (row.intro) return -Infinity;              // intro always first
  if (typeof row.savedSort === 'number') return row.savedSort;
  return DEFAULT_AREAS.findIndex((d) => d.area === row.area);
}

/* Order is the row's position in areaRows — dragging reorders that array, so
   the list itself is the source of truth. The intro always sorts to -1 so it
   stays ahead of every room regardless of where it sits in the list. */
function orderOf(row) {
  if (row.intro) return -1;
  const i = areaRows.indexOf(row);
  return i === -1 ? 0 : i;
}

function renderAreas() {
  const grid = $('#area-grid');
  // Reversed clips are only used by the Video Walkthrough player, so the
  // Interactive tab shows a single drop per room.
  const wantsReverse = uploadMode() === 'video';

  grid.innerHTML = areaRows.map((r, i) => `
    <div class="area-slot${r.intro ? ' optional' : ''}" data-area="${escapeHtml(r.area)}" data-index="${i}"
         ${r.intro ? '' : 'draggable="true"'}>
      <div class="area-label">
        ${r.intro ? '' : '<span class="area-drag" title="Drag to reorder" aria-hidden="true">⠿</span>'}
        <input class="area-name" type="text" value="${escapeHtml(r.label)}"
               aria-label="Area name" ${r.intro ? 'readonly' : ''}>
        ${r.intro ? '<span class="area-opt">optional</span>' : ''}
        ${r.intro ? '' : '<button class="area-remove" title="Remove this area" aria-label="Remove">&times;</button>'}
      </div>
      <div class="area-drops">
        <label class="area-drop" data-kind="forward">
          <input type="file" accept="video/mp4,video/quicktime,video/webm" hidden>
          ${wantsReverse ? '<span class="drop-kind">Forward</span>' : ''}
          <span class="area-hint">${r.hasVideo ? 'Uploaded' : 'Choose or drop'}</span>
        </label>
        ${wantsReverse ? `
        <label class="area-drop" data-kind="reverse">
          <input type="file" accept="video/mp4,video/quicktime,video/webm" hidden>
          <span class="drop-kind">Backward</span>
          <span class="area-hint">${r.hasReverse ? 'Uploaded' : 'Choose or drop'}</span>
        </label>` : ''}
      </div>
      <div class="area-progress"><div class="area-progress-fill"></div></div>
    </div>`
  ).join('');

  grid.querySelectorAll('.area-slot').forEach(wireSlot);
  wireDragReorder(grid);
}

/* Drag a slot onto another to move it there. The intro isn't draggable and
   can't be displaced — it always plays first. */
function wireDragReorder(grid) {
  let dragArea = null;

  grid.querySelectorAll('.area-slot[draggable="true"]').forEach((slot) => {
    // Only the handle starts a drag — otherwise selecting text in the name
    // field drags the whole card instead.
    const handle = slot.querySelector('.area-drag');
    let fromHandle = false;
    if (handle) {
      handle.addEventListener('mousedown', () => { fromHandle = true; });
      slot.addEventListener('mouseup', () => { fromHandle = false; });
    }

    slot.addEventListener('dragstart', (e) => {
      if (!fromHandle) { e.preventDefault(); return; }
      dragArea = slot.dataset.area;
      slot.classList.add('dragging-slot');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox won't start a drag without data set.
      e.dataTransfer.setData('text/plain', dragArea);
    });

    slot.addEventListener('dragend', () => {
      slot.classList.remove('dragging-slot');
      grid.querySelectorAll('.area-slot').forEach((s) => s.classList.remove('drop-target'));
      dragArea = null;
      fromHandle = false;
    });

    slot.addEventListener('dragover', (e) => {
      if (!dragArea || slot.dataset.area === dragArea) return;
      e.preventDefault();                   // required to allow a drop
      e.dataTransfer.dropEffect = 'move';
      slot.classList.add('drop-target');
    });

    slot.addEventListener('dragleave', () => slot.classList.remove('drop-target'));

    slot.addEventListener('drop', (e) => {
      e.preventDefault();
      slot.classList.remove('drop-target');

      const from = areaRows.findIndex((r) => r.area === dragArea);
      const to = areaRows.findIndex((r) => r.area === slot.dataset.area);
      if (from === -1 || to === -1 || from === to) return;

      const [moved] = areaRows.splice(from, 1);
      areaRows.splice(to, 0, moved);

      renderAreas();                        // re-render in the new order
      setStatus('Order changed — press Save & Upload to keep it.', false);
    });
  });
}

/* Renaming only changes the display label; `area` (the storage path + row key)
   stays fixed so an existing upload isn't orphaned by a rename. */
function wireAreaName(slot, row) {
  const input = slot.querySelector('.area-name');
  if (!input || row.intro) return;

  input.addEventListener('input', () => { row.label = input.value; });
  input.addEventListener('blur', () => {
    const clean = input.value.trim();
    row.label = clean || row.area;
    input.value = row.label;
  });
  // Typing in the name field shouldn't open the file picker.
  input.addEventListener('click', (e) => e.stopPropagation());
}

function wireAreaRemove(slot, row) {
  const btn = slot.querySelector('.area-remove');
  if (!btn) return;

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (row.existing && row.hasVideo) {
      const ok = confirm(
        `Remove "${row.label}"? Its uploaded video will be deleted from this walkthrough.`
      );
      if (!ok) return;
      await deleteArea(row);
    }

    staged.delete(row.area);
    areaRows = areaRows.filter((r) => r !== row);
    renderAreas();
    $('#start-upload').disabled = staged.size === 0;
  });
}

async function deleteArea(row) {
  if (!db || !selectedPropertyId) return;
  const { error } = await db
    .from('property_videos')
    .delete()
    .eq('property_id', selectedPropertyId)
    .eq('area', row.area);
  if (error) setStatus(explainError(error, `remove ${row.label}`), true);
}

function addArea() {
  const name = ($('#new-area-name').value || '').trim();
  if (!name) return;

  const base = slugify(name);
  if (!base) {
    setStatus('Give the area a name using letters or numbers.', true);
    return;
  }

  // `area` has to stay unique per property — it's the row key and storage path.
  let slug = base;
  let n = 2;
  while (areaRows.some((r) => r.area === slug)) slug = `${base}-${n++}`;

  // Appends to the end; position (and therefore sort_order) is whatever the
  // list says after any dragging.
  areaRows.push({ area: slug, label: name, existing: false, hasVideo: false });

  $('#new-area-name').value = '';
  setStatus('', false);
  renderAreas();
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

function wireSlot(slot) {
  const area = slot.dataset.area;
  const row = areaRows[Number(slot.dataset.index)];

  if (row) {
    wireAreaName(slot, row);
    wireAreaRemove(slot, row);
  }

  // Each room has two drops: the forward clip and the pre-rendered reversed
  // one. They're staged under separate keys so both can upload in one go.
  slot.querySelectorAll('.area-drop').forEach((drop) => {
    const kind = drop.dataset.kind;                 // 'forward' | 'reverse'
    const key = stageKey(area, kind);
    const input = drop.querySelector('input[type=file]');
    const hint = drop.querySelector('.area-hint');

    // Re-show a file staged before the last re-render.
    const pending = staged.get(key);
    if (pending) setDropState(drop, 'staged', `${pending.name} · ${formatSize(pending.size)}`);

    input.addEventListener('change', () => {
      if (input.files[0]) stageFile(drop, key, input.files[0]);
    });

    ['dragenter', 'dragover'].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.add('dragging');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.remove('dragging');
      })
    );
    drop.addEventListener('drop', (e) => {
      const file = e.dataTransfer.files[0];
      if (file) stageFile(drop, key, file);
    });

    if (!hint.textContent.trim()) hint.textContent = 'Choose or drop';
  });
}

/* staged is keyed "<area>::<kind>" so forward and reverse don't collide. */
function stageKey(area, kind) { return `${area}::${kind}`; }
function parseKey(key) {
  const [area, kind] = key.split('::');
  return { area, kind: kind || 'forward' };
}

function stageFile(drop, key, file) {
  if (!file.type.startsWith('video/')) {
    setDropState(drop, 'error', 'Not a video file');
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    setDropState(drop, 'error', `Too large (max 500MB)`);
    return;
  }
  staged.set(key, file);
  setDropState(drop, 'staged', `${file.name} · ${formatSize(file.size)}`);
  // Save is never gated on a staged file — renames, reorders and title/address
  // edits are all savable on their own. (Bug: this used to disable the button
  // whenever nothing was staged, so a rename-only edit couldn't be saved.)
  $('#start-upload').disabled = false;
}

function setDropState(drop, state, text) {
  drop.classList.remove('staged', 'error', 'done', 'uploading');
  drop.classList.add(state);
  drop.querySelector('.area-hint').textContent = text;
}

/* Finds the drop element for a staged key, after any re-render. */
function dropFor(key) {
  const { area, kind } = parseKey(key);
  return $(`.area-slot[data-area="${area}"] .area-drop[data-kind="${kind}"]`);
}

function setSlotProgress(slot, pct) {
  slot.querySelector('.area-progress-fill').style.width = `${pct}%`;
}

/* ---------- upload ---------- */

async function startUpload() {
  if (!db || !selectedPropertyId) return;

  const property = properties.find((p) => p.id === selectedPropertyId);
  $('#start-upload').disabled = true;
  $('#back-to-property').disabled = true;

  // Renames and title/address edits are worth saving even with nothing staged,
  // so "Save & Upload" is useful as a plain Save too.
  await savePropertyDetails();
  const renamed = await saveRenames();

  if (staged.size === 0) {
    $('#start-upload').disabled = false;
    $('#back-to-property').disabled = false;
    setStatus(
      renamed ? 'Saved.' : 'Nothing to upload — add a video to a slot first.',
      !renamed
    );
    return;
  }

  let done = 0;
  let failed = 0;

  for (const [key, file] of staged) {
    const { area, kind } = parseKey(key);
    const slot = $(`.area-slot[data-area="${area}"]`);
    const drop = dropFor(key);
    const meta = areaRows.find((r) => r.area === area);
    if (!slot || !drop || !meta) continue; // area was removed after staging

    setDropState(drop, 'uploading', 'Uploading…');
    setSlotProgress(slot, 0);

    const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
    // Reversed clips get their own object so they never overwrite the forward one.
    const path = `${property.slug}/${area}${kind === 'reverse' ? '-reverse' : ''}.${ext}`;

    // Replacing a .mp4 with a .mov writes a DIFFERENT object, leaving the old
    // one behind — still stored, still billed, and still the one some cached
    // client might hold. Remove the previous file when the extension changes.
    const prevPath = kind === 'reverse' ? meta.reversePath : meta.storagePath;
    if (prevPath && prevPath !== path) {
      await db.storage.from(cfg.bucket || 'walkthrough-videos').remove([prevPath]);
    }

    const { error: upErr } = await db.storage
      .from(cfg.bucket || 'walkthrough-videos')
      .upload(path, file, { upsert: true, contentType: file.type });

    if (upErr) {
      setDropState(drop, 'error', explainError(upErr, 'upload'));
      failed++;
      continue;
    }

    setSlotProgress(slot, 100);

    const { data: pub } = db.storage
      .from(cfg.bucket || 'walkthrough-videos')
      .getPublicUrl(path);

    // Replacing a clip reuses the same storage path, so the public URL never
    // changes — and anything keyed by URL (our Cache Storage, the browser's own
    // cache, a CDN) would happily keep serving the OLD video forever. A version
    // stamp makes each replacement a distinct URL, so the new file actually
    // reaches viewers.
    const publicUrl = `${pub.publicUrl}?v=${Date.now()}`;

    const record = {
      property_id: selectedPropertyId,
      area,
      label: meta.label,
      sort_order: orderOf(meta),
    };
    if (kind === 'reverse') {
      record.reverse_url = publicUrl;
      record.reverse_path = path;
    } else {
      record.video_url = publicUrl;
      record.storage_path = path;
    }

    const { error: rowErr } = await db.from('property_videos').upsert(
      record,
      { onConflict: 'property_id,area' }
    );

    if (rowErr) {
      setDropState(drop, 'error', explainError(rowErr, 'save the link'));
      failed++;
      continue;
    }

    setDropState(drop, 'done', 'Uploaded');
    done++;
  }

  staged.clear();
  $('#back-to-property').disabled = false;
  setStatus(
    failed
      ? `${done} uploaded, ${failed} failed — see the slots above.`
      : `${done} video${done === 1 ? '' : 's'} uploaded to ${property.title}.`,
    failed > 0
  );
}

/* Persists label changes for areas that already exist in the DB. Areas with no
   row yet get their label written when their video uploads. */
async function saveRenames() {
  if (!db || !selectedPropertyId) return false;
  if (!areaRows.length) return false;

  // Upsert rather than update: a renamed/reordered area that has never had a
  // video uploaded has no row yet, and an UPDATE would silently match nothing.
  // That was the "edits don't save" bug — the rename looked accepted but never
  // reached the database.
  const rows = areaRows.map((row) => ({
    property_id: selectedPropertyId,
    area: row.area,
    label: row.label,
    sort_order: orderOf(row),
  }));

  const { error } = await db
    .from('property_videos')
    .upsert(rows, { onConflict: 'property_id,area' });

  if (error) {
    setStatus(explainError(error, 'save your changes'), true);
    return false;
  }

  // Rows now exist for every slot, so later saves update in place.
  areaRows.forEach((r) => { r.existing = true; });
  return true;
}

/* Saves the property title/address edited at the top of step 2. */
async function savePropertyDetails() {
  if (!db || !selectedPropertyId) return;

  const title = ($('#edit-title').value || '').trim();
  const address = ($('#edit-address').value || '').trim();
  const current = properties.find((p) => p.id === selectedPropertyId);
  if (!current || !title) return;
  if (title === current.title && address === (current.address || '')) return;

  const { error } = await db
    .from('properties')
    .update({ title, address })
    .eq('id', selectedPropertyId);

  if (error) {
    setStatus(explainError(error, 'save the property details'), true);
    return;
  }

  current.title = title;
  current.address = address;
}

/* ---------- helpers ---------- */

function setStatus(msg, isError) {
  const el = $('#upload-status');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}

/* Step 1 has its own status line — #upload-status lives in step 2, so errors
   from the property step would otherwise be written to a hidden element. */
function setPropertyStatus(msg, isError) {
  const el = $('#property-status');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
}

/* Supabase's raw errors are accurate but not actionable. The RLS one is the
   error people actually hit here, so it gets a real instruction. */
function explainError(error, action) {
  const msg = String(error && error.message ? error.message : error);

  if (/row-level security/i.test(msg) || error?.code === '42501') {
    return (
      `Couldn't ${action}: the database is blocking writes. Run ` +
      `supabase/migrations/001-open-uploads-to-anon.sql in your Supabase SQL editor.`
    );
  }
  if (/duplicate key|already exists/i.test(msg) || error?.code === '23505') {
    return 'A property with that name already exists — pick it from the list above.';
  }
  if (/Failed to fetch|NetworkError/i.test(msg)) {
    return `Couldn't ${action}: no connection to Supabase. Check the URL in .env.`;
  }
  return `Couldn't ${action}: ${msg}`;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

/* ---------- wiring ---------- */

document.addEventListener('DOMContentLoaded', () => {
  $('#upload-btn').addEventListener('click', openModal);
  $('#upload-close').addEventListener('click', closeModal);
  $('#upload-modal').addEventListener('click', (e) => {
    if (e.target.id === 'upload-modal') closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#upload-modal').classList.contains('open')) closeModal();
  });

  $('#to-areas').addEventListener('click', async () => {
    const p = properties.find((x) => x.id === selectedPropertyId);
    $('#edit-title').value = p ? p.title : '';
    $('#edit-address').value = p ? (p.address || '') : '';
    setStatus('Loading areas…', false);
    showStep(2);
    await buildAreaRows();   // pulls saved labels + custom areas
    renderAreas();
    setStatus('', false);
  });
  $('#back-to-property').addEventListener('click', () => showStep(1));

  $('#add-area').addEventListener('click', addArea);
  $('#new-area-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addArea(); }
  });

  $('#show-new-property').addEventListener('click', () => {
    $('#new-property-form').classList.toggle('open');
  });
  $('#save-new-property').addEventListener('click', createProperty);

  $('#start-upload').addEventListener('click', startUpload);
});
