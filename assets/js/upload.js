/* Lion Rock — upload modal
 *
 * Two steps:
 *   1. "What property" — pick an existing property from Supabase, or add a new one
 *   2. The 7 room areas — one drop/pick slot each, uploaded to Storage
 *
 * Each finished upload writes a row into `property_videos` (upserted on
 * property_id + area, so re-uploading an area replaces it).
 */

/* The upload slots, in timeline order — mirrors the `area` check constraint in
   supabase/schema.sql (see migration 003 for 'intro'). Adding one means
   updating both.

   The intro is optional and isn't a room: it plays first and sits behind the
   loader, then the walkthrough continues into Exterior. Leave it empty and the
   walkthrough just starts on Exterior. */
const ROOM_AREAS = [
  { area: 'intro',     label: 'Intro',      optional: true, sort: -1 },
  { area: 'exterior',  label: 'Exterior',   sort: 0 },
  { area: 'living',    label: 'Living',     sort: 1 },
  { area: 'dining',    label: 'Dining',     sort: 2 },
  { area: 'kitchen',   label: 'Kitchen',    sort: 3 },
  { area: 'bedroom-1', label: 'Bedroom 1',  sort: 4 },
  { area: 'bathroom',  label: 'Bathroom',   sort: 5 },
  { area: 'bedroom-2', label: 'Bedroom 2',  sort: 6 },
];

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
  renderAreas();
}

function showStep(n) {
  $('#step-property').classList.toggle('active', n === 1);
  $('#step-areas').classList.toggle('active', n === 2);
}

/* ---------- step 1: what property ---------- */

async function loadProperties() {
  const list = $('#property-list');

  if (!db) {
    list.innerHTML =
      '<p class="upload-note">Supabase isn\'t configured yet. Add your project URL and anon key to ' +
      '<code>assets/js/supabase-config.js</code>, then run <code>supabase/schema.sql</code> in the SQL editor.</p>';
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

function renderAreas() {
  $('#area-grid').innerHTML = ROOM_AREAS.map(
    (r) => `
    <div class="area-slot${r.optional ? ' optional' : ''}" data-area="${r.area}">
      <div class="area-label">${r.label}${r.optional ? '<span class="area-opt">optional</span>' : ''}</div>
      <label class="area-drop">
        <input type="file" accept="video/mp4,video/quicktime,video/webm" hidden>
        <span class="area-hint">Choose or drop a video</span>
      </label>
      <div class="area-progress"><div class="area-progress-fill"></div></div>
    </div>`
  ).join('');

  $('#area-grid').querySelectorAll('.area-slot').forEach(wireSlot);
}

function wireSlot(slot) {
  const area = slot.dataset.area;
  const input = slot.querySelector('input[type=file]');
  const drop = slot.querySelector('.area-drop');

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
  if (!db || !selectedPropertyId || staged.size === 0) return;

  const property = properties.find((p) => p.id === selectedPropertyId);
  $('#start-upload').disabled = true;
  $('#back-to-property').disabled = true;

  let done = 0;
  let failed = 0;

  for (const [area, file] of staged) {
    const slot = $(`.area-slot[data-area="${area}"]`);
    const meta = ROOM_AREAS.find((r) => r.area === area);

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
        sort_order: meta.sort,
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
  renderAreas();

  $('#upload-btn').addEventListener('click', openModal);
  $('#upload-close').addEventListener('click', closeModal);
  $('#upload-modal').addEventListener('click', (e) => {
    if (e.target.id === 'upload-modal') closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('#upload-modal').classList.contains('open')) closeModal();
  });

  $('#to-areas').addEventListener('click', () => {
    const p = properties.find((x) => x.id === selectedPropertyId);
    $('#areas-for').textContent = p ? `${p.title} — ${p.address || p.slug}` : '';
    setStatus('', false);
    showStep(2);
  });
  $('#back-to-property').addEventListener('click', () => showStep(1));

  $('#show-new-property').addEventListener('click', () => {
    $('#new-property-form').classList.toggle('open');
  });
  $('#save-new-property').addEventListener('click', createProperty);

  $('#start-upload').addEventListener('click', startUpload);
});
