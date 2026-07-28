# Lion Rock — Portfolio

`/` is a gallery of projects. Each project is its own folder with its own
scroll/swipe-controlled video walkthrough. No build step — it's plain
HTML/CSS/JS, so it deploys to Netlify as-is.

## Project structure

```
index.html                            Root gallery: grid of project thumbnails
assets/img/lion-rock-logo.png         Shared brand logo (used by the gallery)

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
- **Cache loader**: every room video is downloaded as a Blob up front (with a
  real buffering progress bar) before the site reveals itself, so scrubbing
  never touches the network again for the rest of that page session. A full
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
