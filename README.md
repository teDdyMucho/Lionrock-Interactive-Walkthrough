# Lion Rock — Portfolio

`/` is a gallery of projects. Each project is its own folder with its own
scroll/swipe-controlled video walkthrough. No build step — it's plain
HTML/CSS/JS, so it deploys to Netlify as-is.

## Project structure

```
index.html                            Root gallery: grid of project thumbnails + Upload button
assets/img/lion-rock-logo.png         Shared brand logo (used by the gallery)
assets/js/supabase-config.js          Supabase URL + anon key (generated from .env)
assets/js/upload.js                   Upload modal: property picker → 7 room slots
assets/js/gallery.js                  Appends a card per uploaded property
scripts/gen-config.js                 Writes supabase-config.js from .env
supabase/schema.sql                   Tables, Storage bucket, and RLS policies
supabase/migrations/                  Policy changes to run after schema.sql

walkthrough/                          Shared walkthrough for uploaded properties
  index.html                          Page shell, driven by ?property=<slug>
  assets/rooms-source.js              Builds the room list from Supabase
  assets/main.js                      Scrub engine (copy of the per-project one)

2209-Branch-Ave-Anoka-MN-55303/       One project ("Unit 9")
  index.html                          Page shell (loader, header, footer, stage)
  assets/css/style.css                Layout + visual styling
  assets/js/main.js                   Cache/preload loader, scrub engine, nav wiring
  content/rooms.json                  Editable content: property info + room list/labels/videos
  videos/2209-branch-ave/             The 7 room clips + intro.mp4 (loader background)

admin/                                Decap CMS (the "Editor" screen) - shared across all projects
```

Each project's HTML/JS references its own assets with absolute paths prefixed
by its folder name (e.g. `/2209-Branch-Ave-Anoka-MN-55303/assets/js/main.js`)
rather than relative paths — that avoids a trailing-slash edge case where a
static host can resolve `folder/index.html`'s relative URLs against `/folder`
instead of `/folder/`.

`main.js` renders the header nav, the dot nav, and every room straight from
that project's `content/rooms.json` — nothing about rooms is hardcoded in
`index.html`. That's what lets the Editor add/rename/reorder rooms without
touching code.

## Adding another project

1. Copy the `2209-Branch-Ave-Anoka-MN-55303/` folder, rename it to the new
   project's slug (e.g. `123-Main-St/`).
2. Find-and-replace the old folder name with the new one across the copied
   `index.html`, `assets/js/main.js`, and `content/rooms.json` (they all
   reference the absolute path).
3. Add a matching `files:` entry for it in `admin/config.yml` (copy the
   existing `unit9` entry and repoint `file`/`media_folder`/`public_folder`).
4. Add a matching pair of `[[headers]]` blocks in `netlify.toml` for its
   `videos/*` and `content/*` paths.
5. Add a card for it in the root `index.html` gallery grid.

## Editor vs. Viewer

The two pill buttons in the bottom-left corner of a project page (invisible
until hovered) are the temporary role switch:

- **Viewer** — the public walkthrough. Anyone can scroll/scrub/jump nav. No
  edit capability at all. Hidden entirely on mobile — phones are viewer-only.
- **Editor** — opens `/admin/`, a Decap CMS screen. Logging in there is
  gated by Netlify Identity (see setup below), so only invited editors can
  get in. From that screen an editor can:
  - Rename any nav label (renames the room's entry on the walkthrough)
  - Upload a new video and add it as a new room (tags it to the nav automatically)
  - Reorder rooms (drag items in the "Rooms" list)
  - Replace a room's video
  - Edit the property title/address/footer text and the logo link

Saving in the CMS commits straight to that project's `content/rooms.json`
(and uploads new videos into its `videos/` folder) on the `main` branch,
which triggers a Netlify rebuild and republishes automatically.

## 1. Preview locally

There's no build step (no bundler, no framework) — this is plain HTML/CSS/JS
served as-is, so `npm run dev` just starts a static file server:

```bash
npm run dev
```

Then open http://localhost:5000 in your browser (the gallery), and click
through to a project. (Opening `index.html` directly via `file://` won't
work — the project pages `fetch()` their `content/rooms.json`, which requires
an http server. Any static server works if you'd rather not use npm, e.g.
`python -m http.server 8080`.)

To test the CMS locally before Identity/Git Gateway exist, run this in a
second terminal, then open `/admin/`:

```bash
npx decap-server
```

## 2. Push to GitHub

```bash
git init
git add .
git commit -m "Initial Lion Rock walkthrough"
git branch -M main
git remote add origin <your-empty-github-repo-url>
git push -u origin main
```

(Create the empty repo on github.com first — the `gh` CLI isn't installed in
this environment, so this step needs to happen from your GitHub account or
`gh repo create` if you install the CLI.)

## 3. Deploy to Netlify

1. [app.netlify.com](https://app.netlify.com) → **Add new site → Import an
   existing project** → pick this GitHub repo.
2. Build command: leave blank. Publish directory: `.` (repo root).
3. Deploy.

## 4. Turn on the Editor role (Netlify Identity + Git Gateway)

This is the part that makes the "Editor" button actually work in production:

1. Netlify site → **Site configuration → Identity → Enable Identity**.
2. Under Identity **Registration**, set it to **Invite only** (so random
   visitors can't self-register as editors).
3. Identity → **Services → Git Gateway → Enable Git Gateway** (lets the CMS
   commit to GitHub on the editor's behalf without them needing a GitHub
   account).
4. Identity → **Invite users** → send yourself/your editor an invite email.
5. The invite link lands on the site's homepage and pops the Netlify Identity
   modal to set a password — after that, the **Editor** button → `/admin/`
   will log them straight into the CMS.

Until step 4/5 is done for a given person, they simply can't log into
`/admin/` — that's the real permission boundary; the "Editor/Viewer" buttons
are just a shortcut to the two experiences.

## 5. Turn on the Upload button (Supabase)

The **Upload** button in the gallery header opens a two-step modal: first pick
*what property* the videos belong to, then drop a video into each of the 7 room
areas. Files go to a Supabase Storage bucket and the resulting public URL is
saved to a database column.

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query** → paste in `supabase/schema.sql` and run it. It
   creates the `properties` and `property_videos` tables, the
   `walkthrough-videos` Storage bucket, and the RLS policies. It's safe to
   re-run — nothing is dropped.
3. Set up your local config:

   ```bash
   cp .env.example .env      # then paste your values in
   npm run config            # generates assets/js/supabase-config.js from .env
   ```

   **Project Settings → API** is where the Project URL and `anon` public key
   live. You only ever type them into `.env` — `npm run config` generates the
   browser file from it, and `npm run dev` runs it for you automatically.

Until that's done the modal still opens, but the property step shows a
"Supabase isn't configured yet" note instead of a list — nothing crashes.

### Why two config files

This site has **no build step**, so nothing bundles a `.env` into the page and
the browser can't read one. `assets/js/supabase-config.js` is the file the
browser actually loads via a `<script>` tag — that's the one that makes the
upload work. `.env` stays the single source of truth, and
`scripts/gen-config.js` bridges the two so you never type the key twice. (It
also refuses to write a `service_role` key, which would otherwise silently
hand every visitor full database access.)

Both real files are gitignored; only the templates and the generator are
committed, so credentials never land in a commit:

```
.env                                  ignored    ← your real values (edit this one)
.env.example                          committed  ← the template
assets/js/supabase-config.js          ignored    ← generated; the browser reads this
assets/js/supabase-config.example.js  committed  ← the template
scripts/gen-config.js                 committed  ← generates one from the other
```

Never put the `service_role` key in either file. It bypasses RLS entirely and
must never reach the browser — the `anon` key is the only one that belongs
client-side.

### Deploying to Vercel

`assets/js/supabase-config.js` is gitignored, so it does **not** exist in a
fresh clone — Vercel has to generate it at build time. Setting environment
variables alone is not enough: this is a static site with no bundler, so
nothing reads `process.env` in the browser.

1. **Project Settings → Environment Variables** → add `SUPABASE_URL` and
   `SUPABASE_ANON_KEY` (values from `.env`). Apply them to Production,
   Preview, and Development.
2. `vercel.json` already sets `buildCommand: npm run config` and
   `outputDirectory: "."`. If you configured the project before adding that
   file, clear any Framework Preset override in the dashboard so `vercel.json`
   wins.
3. Redeploy. Env var changes only take effect on a **new** build — Vercel does
   not re-run the old one.

To verify: open `/assets/js/supabase-config.js` on the deployed URL. It should
return JS with your project URL. A 404 means the build command didn't run; a
file containing `YOUR-PROJECT-REF` means the env vars weren't set.

### Deploying to Netlify

Since `supabase-config.js` isn't in the repo, Netlify has to generate it at
deploy time — the same script does this:

1. **Site configuration → Environment variables** → add `SUPABASE_URL` and
   `SUPABASE_ANON_KEY`.
2. Set the build command to `npm run config` (publish directory stays `.`).

`gen-config.js` reads real environment variables in preference to `.env`, so
the same command works locally and on Netlify. Skip this and the deployed site
still loads fine — the Upload button will just report that Supabase isn't
configured.

### How uploads are stored

- Storage path is `<property-slug>/<area>.<ext>` (e.g.
  `2209-Branch-Ave-Anoka-MN-55303/kitchen.mp4`).
- `property_videos` has a `unique (property_id, area)` constraint and the
  upload upserts on it, so re-uploading an area **replaces** that room's video
  rather than creating a duplicate row.
- The 7 areas are fixed by a check constraint in the schema and the
  `ROOM_AREAS` list in `assets/js/upload.js` — adding an eighth room means
  updating both.

### Admin sign-in (`/manage/`)

The gallery's **Upload/Edit** button is hidden unless an admin is signed in.
Signing in happens at **`/manage/`** using a real Supabase Auth account — not a
password baked into the page, which anyone could read from the source.

Both halves of the boundary are in place:

- `/manage/` hides the Upload/Edit button unless signed in (UI).
- `supabase/migrations/002-require-login-to-upload.sql` makes the database
  reject writes from anyone who isn't signed in (security). **Applied** — an
  anonymous insert now returns `401`.

To add another admin: **Authentication → Users → Add user** in the Supabase
dashboard, ticking **Auto Confirm User**. Without that tick the account can't
sign in until its email is confirmed.

Signing in redirects straight to the gallery — there's no signed-in screen. It
uses `location.replace()`, so `/manage/` doesn't sit in history and Back can't
bounce you into it. Visiting `/manage/` with a session already active redirects
too.

**Sign out** sits next to Upload/Edit in the gallery header (also admin-only,
also hidden on phones). It opens a **"Sign out?" confirmation** first — the
click alone doesn't end the session, since it's easy to hit by accident and
costs a re-login. Cancel, Escape, or a backdrop click all dismiss it;
confirming ends the session and returns to `/manage/` with a "Signed out."
message.

The redirect carries `?signedout=1`, which suppresses `/manage/`'s
already-signed-in redirect for that one load — otherwise a just-cleared session
that's still readable for a moment would bounce the user straight back to the
gallery.

Otherwise the session persists (supabase-js refreshes it), so an admin device
stays signed in across reloads. To revoke access everywhere, delete or reset the
user in the Supabase dashboard.

The session is stored by supabase-js and shared across pages, so signing in at
`/manage/` immediately reveals the button on the gallery — including in another
tab. `assets/js/upload.js` reuses that same authenticated client, so uploads
carry the session.

The button stays hidden on phones regardless of sign-in (see
`assets/js/admin-gate.js` and the mobile media query).

### Who can upload

✅ **Uploads require a signed-in admin.** Migration 002 is applied, so Supabase
rejects writes from anyone who isn't authenticated — an anonymous insert
returns `401`. Reads stay open, which the public walkthrough needs.

Migration history, for context: `schema.sql` shipped strict, `001` briefly
opened writes to `anon` so the Upload button worked before auth existed, and
`002` closed it again once `/manage/` was built. Don't re-run `001` unless you
deliberately want uploads open to anyone with the URL.

The `anon` key ships in client-side JavaScript and is public by design — that's
expected. RLS, not the key, is what gates writes.

Never use the `service_role` key to work around an RLS error — it bypasses all
policies and must never reach a browser.

### What happens after an upload

Uploaded properties appear in the gallery automatically and are fully
watchable — no code changes, no new folder:

```
index.html            empty grid; every card comes from Supabase
  ↓ assets/js/gallery.js renders a card per property that has videos
walkthrough/          one shared page, driven by ?property=<slug>
  ↓ assets/rooms-source.js  builds {property, rooms} from Supabase
  ↓ assets/main.js          the same scrub engine the per-project pages use
```

Cards link to `/walkthrough/?property=<slug>`, and a property only appears once
it has at least one uploaded video.

### Caching

Clips are written to Cache Storage automatically — no prompt. There used to be
an "Allow saved data?" consent on the gallery, but once the Video tab began
downloading every clip up front the question was moot: the download isn't
optional, so asking permission to *keep* what was just fetched only added a
click. Both players now cache unconditionally, best-effort.

<details>
<summary>Previous behaviour (removed)</summary>

The gallery (welcome page) asks **once**, permission-style:

> **Allow saved data?** — For a smoother experience, please allow this app to
> save data on your device automatically. Projects you open will load faster and
> play without buffering.
> `[Allow] [Decline]`

The wording deliberately avoids "offline": the clips are cached, but the page
shell still needs the network, so promising offline would overstate it. The
honest, user-visible benefit is *faster loading*.

The answer is a single site-wide preference in `localStorage`
(`lionrock-cache-consent`), handled by `assets/js/cache-consent.js`:

- **Allow** — opening any project caches its clips automatically, with no
  further prompting. Caching starts *after* the walkthrough is already playing,
  so it never delays the first frame.
- **Decline** — nothing is ever cached; walkthroughs stream as before.

Either way it isn't asked again. There is deliberately **no prompt on the
walkthrough page itself** — consent lives entirely on the welcome page.

This is **browser storage, not the Downloads folder** — nothing appears in a
file manager. Users can clear it from their browser's site-data settings.

Measured on the sample property: 52.7MB cached across 8 clips; a revisit is
ready in **0.2s with zero network requests for video**.

</details>

Requires a secure context (https, or localhost) — `caches` is unavailable on
plain http, so caching silently skips itself there. Quota errors are caught
and ignored; the walkthrough continues online.

**Caveat — not yet fully offline.** The clips are cached, but the page shell
(HTML/CSS/JS) still comes from the network, so loading the URL with no
connection fails. Making it truly offline needs a service worker to cache the
shell as well; that isn't built yet.

### Renaming and adding areas

Step 2 of the upload modal is fully editable:

- **Area names** — each slot's name is a text field. Renaming changes the nav
  label on the walkthrough; it does **not** change the `area` slug, so an
  existing upload is never orphaned by a rename.
- **Add an area** — type a name and click **+ Add area**. The slug is derived
  from the name and de-duplicated (`garage`, `garage-2`, …). Needs
  `supabase/migrations/004-custom-areas.sql`, which relaxes `area` from a fixed
  whitelist to a slug-shape check.
- **Reorder areas** — drag a slot by its `⠿` handle onto another to move it
  there. Order is the list's own order; `sort_order` is written from it on save.
  The intro isn't draggable — it always plays first.
- **Remove an area** — the `×` on each slot. Removing one that already has a
  video asks first, then deletes its row.
- **Property title / address** — editable at the top of step 2.
- **Delete a unit** — the `×` on a property in step 1. Requires typing the
  unit's name to confirm. Deletes the property (its `property_videos` rows go
  with it via `ON DELETE CASCADE`) *and* its files in Storage, which Postgres
  doesn't manage and would otherwise be left orphaned and still public.

Saving uses an **upsert**, not an update: an area that has never had a video
has no row yet, and an UPDATE would silently match nothing. That was a real bug
— renames appeared to work but never reached the database.

**Replacing a video** appends a `?v=<timestamp>` stamp to the stored URL, and
the offline cache prunes superseded versions of the same path on load
(`VideoCache.pruneStale`). Without both, a browser that had cached the clip kept
playing the old one indefinitely while a fresh browser showed the new one —
which is exactly how the bug presented.
Re-uploading reuses the same storage path, so without the stamp the URL is
unchanged and anything keyed by URL — the offline cache, the browser cache, a
CDN — keeps serving the *old* clip indefinitely. That's why a replaced video
appeared not to change. The upload also deletes the previous object when the
new file has a different extension (`.mov` replacing `.mp4`), which would
otherwise leave the old file stored, billed, and still reachable.

The 8 defaults (Intro + 7 rooms) are just the starting point for a new
property. Once a property has rows in `property_videos`, the modal loads its
saved labels and custom areas instead.

**Save & Upload** saves renames and title/address edits even when no file is
staged, so it doubles as a plain Save.

### Two walkthrough styles

The gallery header has two tabs, each with its **own separate list of
properties** (`properties.mode`, migration 006). A property uploaded to Video
Walkthrough appears only there; the same is true for Interactive. Switching tabs
re-fetches rather than re-pointing the existing cards.

**Upload/Edit follows the selected tab.** The modal shows only that tab's
properties, creates new ones in it, and displays the tab name as a badge in its
header so there's no doubt which list you're editing. The Interactive tab shows
one drop per room; only Video shows the Forward/Backward pair, since reversed
clips are useless to the scrub player.

Existing properties were assigned to `interactive` by the migration — that's
where they were built — so the Video tab starts empty until you add to it.

| | **Video Walkthrough** (`/video/`) | **Interactive Walkthrough (Beta)** (`/walkthrough/`) |
|---|---|---|
| Input | Click, scroll, swipe, or arrow keys | Scroll / swipe to scrub |
| Motion | Plays whole clips end to end | Frame-accurate scrubbing |
| Backwards | Plays a pre-rendered **reversed** clip | Seeks frame by frame (choppier) |
| Needs | Forward **and** reversed clips | Forward clips only |

The chosen tab is remembered in `localStorage`
(`lionrock-walkthrough-mode`), so it survives a reload and a trip into a
walkthrough and back.

#### How the Video Walkthrough moves

No browser can play a `<video>` backwards, which is what makes reverse
scrubbing the weak point of the Interactive tab. The Video tab sidesteps it by
playing a **pre-rendered reversed copy forwards**:

- **Click a later room** → play that room's forward clip. *(1 clip per room
  stepped through.)*
- **Click an earlier room** → play the **current** room's reversed clip
  (walking back out), **then** the target's forward clip (walking in).
  *(2 clips.)* Both are needed — playing only the reverse leaves the viewer
  looking at the room they just left.
- Skipping several rooms chains the same rule, so the path stays continuous
  rather than cutting.

**Scroll and swipe** also move between rooms: one gesture = one room, in the
same direction as the Interactive tab (**down/swipe-up = next**, up = previous).
Arrow and Page keys work too. Each gesture is locked until its transition
finishes rather than on a timer, so one wheel flick — which fires dozens of
events — advances exactly one room instead of racing through the whole unit.
Scrolling past either end does nothing.

Both tabs have the **dot navigation** down the right edge — same room list as
the header, easier to hit on a phone, and it reuses the Interactive player's
markup and styles so the two feel identical. Clicking a dot moves rooms exactly
like clicking the header nav.

Clips are swapped instantly, with no crossfade, and only once the incoming clip
has painted its first frame (`requestVideoFrameCallback`). An earlier 0.25s fade
meant each clip began playing while still transparent — on a 3s reverse clip
that swallowed a visible chunk of it, which read as "the reverse never played"
even though it had.

The nav stays clickable while a clip is playing — a new click **takes over**
from the walk in progress, starting from whichever room has actually been
reached. The room being travelled to is underlined (`.pending`) so the
destination is visible before it arrives.

Interrupting is handled with a `walkToken`: each click bumps it, and the
running loop checks after every clip, bailing out if it's been superseded. The
in-flight clip is paused, and `playClip` resolves on that pause rather than
waiting for an `ended` event that will never fire — otherwise the old walk
would hang and keep advancing behind the new one.
A room with no reversed clip still works — it falls back to the target's
forward clip, just without the walking-backwards effect.

#### Preloading

Clicking a card downloads **every** clip before the walkthrough opens, behind a
progress screen showing real bytes ("Downloading walkthrough… 78% · 32MB /
41MB").

This differs from the Interactive tab on purpose. That one reveals after the
first clip and streams the rest, which is fine when scrubbing moves gradually.
This player jumps a whole room per click, so a clip that hadn't arrived would
stall the walk mid-move.

**Both tabs** now download every clip up front behind a **plain black** screen —
brand, bar, and byte count only. Playing a clip behind the bar previewed the
walkthrough before it had finished loading, and decoded a video nobody was
watching yet.

**Nav and dot clicks** land in the target room immediately, then **play about a
second of it** so the arrival has movement instead of being a hard cut.

The original glide eased across the whole timeline, seeking frame by frame
through every room in between — ~10 decodes for a 3-room jump, which felt like
a hang. Landing first and animating only *inside* the target keeps the motion at
**one seek** instead of ten. The motion itself is real playback, not seeking:
the browser decodes sequential frames, which is smooth by construction.

Tune with `JUMP_PLAY_SECONDS`. Scrolling is untouched and still scrubs
frame-by-frame, which is the point of this player.

The Interactive tab used to reveal after only the first clip and stream the
rest. That looked faster but stuttered whenever scrubbing reached a room whose
video hadn't arrived; waiting once is smoother than stalling at every room
boundary. Its durations are now all measured up front too, so the scroll length
is correct from the first frame instead of shifting as clips land.

The bar fills to a real **100%** and holds there briefly before the walkthrough
opens — jumping from ~90% straight into playback made it look like the download
never finished. Per-clip progress is clamped to that clip's `Content-Length`,
because a clip served from cache reports its whole size at once and would
otherwise push the total past 100%.

Each clip is held as a blob for the session, so **navigation makes zero network
requests** once loaded — verified. With storage consent granted, they're also
written to Cache Storage, and a later visit reads from there instead of
re-downloading.

Upload both clips per room from the **Forward** / **Backward** drops in the
upload modal. Reversed files are stored as `<area>-reverse.<ext>` so they never
overwrite the forward one.

**Requires `supabase/migrations/005-reverse-videos.sql`** (adds `reverse_url` /
`reverse_path`). Until it's run, both pages fall back to forward-only rather
than erroring, and the Backward slots won't save.

### First-visit guides

**Both tabs** show a four-step overlay on a viewer's first visit, sharing one
stylesheet (`walkthrough/assets/guide.css`) so they look identical. Each keeps
its own `localStorage` key — the two players work differently enough that seeing
one doesn't teach you the other.

The Video tab's guide appears *after* the opening clip finishes, so it explains
the controls over a settled frame instead of competing with the video. Its
wording matches that player: "Scroll Down for the Next Room", "Click to jump
straight to a Room".



The first time someone opens a walkthrough, a four-step overlay explains the
controls, advanced by clicking/tapping (or by scrolling/swiping — the gesture
being taught also moves the guide along):

1. Scroll/Swipe **Down** to Continue
2. Scroll/Swipe **Up** to Return
3. Click to instantly go to this Room — ring drawn around a nav item
4. Click to return to Gallery — ring drawn around **← Gallery**

Wording follows the input: *Scroll* on desktop, *Swipe* on touch, keyed off the
same `IS_TOUCH_DEVICE` check the scrub engine uses.

Shown **once per browser** (`lionrock-guide-seen` in `localStorage`) — a
walkthrough people revisit shouldn't re-explain itself every time. Clear that
key to see it again.

Implementation notes:
- The guide sits at `z-index: 95`, *below* the header (100), so the controls
  steps 3–4 point at stay sharp above the blur. Because that leaves them
  clickable, `body.guide-open` disables header pointer events while it's up.
- Rings are sized and positioned from the target's `getBoundingClientRect()` at
  display time, so they hug a short label ("Living") and a long one
  ("← Gallery") equally well and survive nav re-layout.
- On touch the fullscreen prompt claims the first tap, so the guide waits and
  starts when that's dismissed rather than stacking two overlays.
- Wheel/touchmove are throttled (700 ms) — one flick fires dozens of events and
  would otherwise blow through all four steps at once.

### Sharing a walkthrough

Each gallery thumbnail has a **share** button (top-right, appears on hover;
always visible on touch). It opens the native share sheet where one exists
(phones) and otherwise copies the walkthrough URL with a brief "Copied"
confirmation. The card is a link, so the button stops the click from opening
the walkthrough.

Clipboard access needs a secure context; on plain http it falls back to a
selectable prompt.

### The Intro slot

The upload modal has 8 slots: an optional **Intro** plus the 7 rooms. The intro
plays first, sits behind the loading bar, and is where the timeline loops back
to after the last room — it gets no nav link or dot of its own.

Leave it empty and the walkthrough simply opens on Exterior. (Don't reuse a room
clip as the intro: it would then play twice before the walkthrough moves on.)
`intro` needs `supabase/migrations/003-add-intro-video.sql` to be allowed.

`walkthrough/assets/main.js` is a copy of the per-project engine with exactly
one change — it calls `loadRoomsFromSupabase()` instead of fetching
`content/rooms.json`. If you tune the scrub feel in one, port it to the other.

Two systems coexist deliberately: the Decap CMS "Editor" screen commits videos
to `rooms.json` in git (that's how Unit 9 works), while the Upload button
writes to Supabase (how everything new works). Unit 9 keeps its folder and
behaves exactly as before.

## Notes / things to know

- **Scrubbing feel**: motion is velocity/friction based (momentum) - each
  scroll/swipe adds an impulse to a velocity that decays under `FRICTION`
  each frame. Forward motion (velocity > 0) plays the `<video>` for real,
  with `playbackRate` tied to the decaying velocity, so the browser handles
  smooth sequential frame decoding instead of repeated seeks - it plays fast,
  then eases down to a stop. Backward motion has to fall back to seeking
  `currentTime` every frame, because no browser supports reverse `<video>`
  playback at all. Backward's seek jumps are capped smaller than forward's
  (`MAX_BACKWARD_VELOCITY`) since every backward step costs real decode time,
  and it uses `video.fastSeek()` where supported (seeks to the nearest
  keyframe rather than decoding an exact frame - faster, slightly less
  precise). Nav/dot jumps use a separate smooth glide-to-target (seek-based,
  since it can go either direction). `SCRUB_SENSITIVITY`,
  `TOUCH_SENSITIVITY`, `FRICTION`, `MAX_VELOCITY`, `MAX_BACKWARD_VELOCITY`,
  `MIN_PLAYBACK_RATE`, and `MAX_PLAYBACK_RATE` at the top of each project's
  `assets/js/main.js` control the feel — tune to taste. If backward scrubbing
  still looks choppy, that's the seeking path hitting sparse keyframes;
  re-export clips with more frequent keyframes (e.g. `-g 15` in ffmpeg) to
  fix it, or consider pre-rendering a reversed copy of each clip so backward
  scrubbing can also use real forward playback (bigger change - ask if you
  want this built).
- **Cache loader**: every room video is downloaded as a Blob (with a real
  buffering progress bar) so scrubbing never touches the network again for the
  rest of that page session. The shared `walkthrough/` page only *waits* on the
  first clip before revealing — the rest stream in behind it, so a 7-room
  property is watchable after ~7MB instead of ~45MB. Rooms join the timeline as
  their metadata lands; `switchToRoom`/`prewarmNeighbor` no-op on a room whose
  blob hasn't arrived yet.
- **Scrub pacing**: backward motion and mid-glide seeks are decoder-paced — a
  new seek is only issued once the previous one's `seeked` event has fired.
  Firing one per animation frame queues work the decoder can't keep up with,
  which is what reads as stutter. Position still accumulates every frame, so
  the momentum physics stay frame-accurate. A full
  page reload re-downloads from scratch, but `netlify.toml`'s long
  `Cache-Control` on `/videos/*` means that's normally served from the
  browser's own disk cache rather than re-fetched over the network.
- **Mobile**: portrait is force-rotated to landscape via a CSS transform
  (sized off `100dvh`/`100dvw` so it always matches the actual visible area
  below the address bar, without requesting true fullscreen). Touch input
  uses swipe up/down instead of wheel. On the first tap each load, a "Continue
  in fullscreen" prompt requests the Fullscreen API — this hides the address
  bar on Android Chrome, but iOS Safari doesn't support the Fullscreen API at
  all, so on iPhone the prompt is effectively a no-op dismiss button.
