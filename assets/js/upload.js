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

const cfg = window.SUPABASE_CONFIG || {};
const configured =
  cfg.url && cfg.anonKey &&
  !cfg.url.includes('YOUR-PROJECT-REF') &&
  !cfg.anonKey.includes('YOUR-ANON');

const db = configured
  ? window.supabase.createClient(cfg.url, cfg.anonKey)
  : null;

/* selected file per area, keyed by area id */
const staged = new Map();
let properties = [];
let selectedPropertyId = null;

const $ = (sel) => document.querySelector(sel);

/* ---------- open / close ---------- */

function openModal() {
  $('#upload-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
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

  const { data, error } = await db
    .from('properties')
    .select('id, slug, title, address')
    .order('title');

  if (error) {
    list.innerHTML = `<p class="upload-note error">Couldn't load properties: ${error.message}</p>`;
    return;
  }

  properties = data || [];

  if (!properties.length) {
    list.innerHTML = '<p class="upload-note">No properties yet — add one below.</p>';
    return;
  }

  list.innerHTML = properties
    .map(
      (p) => `
      <button class="property-option" data-id="${p.id}">
        <span class="property-name">${escapeHtml(p.title)}</span>
        <span class="property-address">${escapeHtml(p.address || p.slug)}</span>
      </button>`
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

  const { data, error } = await db
    .from('properties')
    .insert({ slug, title, address })
    .select()
    .single();

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

  const { data, error } = await db
    .from('property_videos')
    .select('area, label, video_url, sort_order')
    .eq('property_id', selectedPropertyId)
    .order('sort_order');

  if (error || !data) return;

  data.forEach((row) => {
    const match = areaRows.find((r) => r.area === row.area);
    if (match) {
      match.label = row.label || match.label;   // saved rename wins
      match.existing = true;
      match.hasVideo = !!row.video_url;
    } else {
      areaRows.push({
        area: row.area,
        label: row.label || row.area,
        intro: row.area === 'intro',
        existing: true,
        hasVideo: !!row.video_url,
        sort: row.sort_order,
      });
    }
  });

  // Keep DB order for rows that have one; new defaults fall in after.
  areaRows.sort((a, b) => orderOf(a) - orderOf(b));
}

function orderOf(row) {
  if (row.intro) return -1;
  if (typeof row.sort === 'number') return row.sort;
  return DEFAULT_AREAS.findIndex((d) => d.area === row.area);
}

function renderAreas() {
  const grid = $('#area-grid');

  grid.innerHTML = areaRows.map((r, i) => `
    <div class="area-slot${r.intro ? ' optional' : ''}" data-area="${escapeHtml(r.area)}" data-index="${i}">
      <div class="area-label">
        <input class="area-name" type="text" value="${escapeHtml(r.label)}"
               aria-label="Area name" ${r.intro ? 'readonly' : ''}>
        ${r.intro ? '<span class="area-opt">optional</span>' : ''}
        ${r.intro ? '' : '<button class="area-remove" title="Remove this area" aria-label="Remove">&times;</button>'}
      </div>
      <label class="area-drop">
        <input type="file" accept="video/mp4,video/quicktime,video/webm" hidden>
        <span class="area-hint">${r.hasVideo ? 'Uploaded — choose a file to replace' : 'Choose or drop a video'}</span>
      </label>
      <div class="area-progress"><div class="area-progress-fill"></div></div>
    </div>`
  ).join('');

  grid.querySelectorAll('.area-slot').forEach(wireSlot);
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

  areaRows.push({
    area: slug,
    label: name,
    existing: false,
    hasVideo: false,
    sort: Math.max(0, ...areaRows.map(orderOf)) + 1,
  });

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
  const input = slot.querySelector('input[type=file]');
  const drop = slot.querySelector('.area-drop');

  if (row) {
    wireAreaName(slot, row);
    wireAreaRemove(slot, row);
    // Re-show a file staged before the last re-render.
    const pending = staged.get(area);
    if (pending) setSlotState(slot, 'staged', `${pending.name} · ${formatSize(pending.size)}`);
  }

  input.addEventListener('change', () => {
    if (input.files[0]) stageFile(slot, area, input.files[0]);
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
    if (file) stageFile(slot, area, file);
  });
}

function stageFile(slot, area, file) {
  if (!file.type.startsWith('video/')) {
    setSlotState(slot, 'error', 'Not a video file');
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    setSlotState(slot, 'error', `Too large (${formatSize(file.size)} — max 500MB)`);
    return;
  }
  staged.set(area, file);
  setSlotState(slot, 'staged', `${file.name} · ${formatSize(file.size)}`);
  $('#start-upload').disabled = staged.size === 0;
}

function setSlotState(slot, state, text) {
  slot.classList.remove('staged', 'error', 'done', 'uploading');
  slot.classList.add(state);
  slot.querySelector('.area-hint').textContent = text;
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

  for (const [area, file] of staged) {
    const slot = $(`.area-slot[data-area="${area}"]`);
    const meta = areaRows.find((r) => r.area === area);
    if (!slot || !meta) continue; // area was removed after staging

    setSlotState(slot, 'uploading', `Uploading ${file.name}…`);
    setSlotProgress(slot, 0);

    const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
    const path = `${property.slug}/${area}.${ext}`;

    const { error: upErr } = await db.storage
      .from(cfg.bucket || 'walkthrough-videos')
      .upload(path, file, { upsert: true, contentType: file.type });

    if (upErr) {
      setSlotState(slot, 'error', explainError(upErr, 'upload'));
      failed++;
      continue;
    }

    setSlotProgress(slot, 100);

    const { data: pub } = db.storage
      .from(cfg.bucket || 'walkthrough-videos')
      .getPublicUrl(path);

    const { error: rowErr } = await db.from('property_videos').upsert(
      {
        property_id: selectedPropertyId,
        area,
        label: meta.label,
        video_url: pub.publicUrl,
        storage_path: path,
        sort_order: orderOf(meta),
      },
      { onConflict: 'property_id,area' }
    );

    if (rowErr) {
      setSlotState(slot, 'error', explainError(rowErr, 'save the link'));
      failed++;
      continue;
    }

    setSlotState(slot, 'done', 'Uploaded');
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

  const edits = areaRows.filter((r) => r.existing);
  if (!edits.length) return false;

  let changed = false;
  for (const row of edits) {
    const { error } = await db
      .from('property_videos')
      .update({ label: row.label, sort_order: orderOf(row) })
      .eq('property_id', selectedPropertyId)
      .eq('area', row.area);
    if (error) {
      setStatus(explainError(error, `rename ${row.area}`), true);
      return false;
    }
    changed = true;
  }
  return changed;
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
