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

### Who can upload

⚠️ **Uploads are currently open to everyone.** `schema.sql` ships with strict
policies (writes require a login), but
`supabase/migrations/001-open-uploads-to-anon.sql` widens them to `anon` so the
Upload button works without a sign-in step.

The `anon` key ships in client-side JavaScript and is public by design, so with
migration 001 applied, **anyone who finds the site URL can upload videos into
your bucket and create properties.** There's no rate limit and no record of who
uploaded what. That's a reasonable tradeoff for a demo or soft launch — but
before the site is widely public, run
`supabase/migrations/002-require-login-to-upload.sql` to reverse it, and add
Supabase Auth to the modal at the same time (nothing signs a user in yet, so
locking down without adding auth just breaks the button).

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
