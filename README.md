# Lion Rock — Interactive Walkthrough

A scroll-controlled video walkthrough. Mouse-wheel down scrubs the current
room's video forward, wheel up scrubs it backward (with eased/smoothed
seeking), and once a clip reaches its start/end the page hands scroll back
so the visitor glides into the next room. The top nav and the right-side dot
nav both jump straight to a room.

No build step — it's plain HTML/CSS/JS, so it deploys to Netlify as-is.

## Project structure

```
index.html              Page shell (loader, header, footer, mount point for rooms)
assets/css/style.css    Layout + visual styling
assets/js/main.js       Cache/preload loader, scroll-scrub engine, nav wiring
content/rooms.json      All editable content: property info + room list/labels/videos
videos/2209-branch-ave/ The 7 room clips + intro.mp4 (used as the loader background)
admin/                  Decap CMS (the "Editor" screen)
```

`main.js` renders the header nav, the dot nav, and every room section straight
from `content/rooms.json` — nothing about rooms is hardcoded in `index.html`.
That's what lets the Editor add/rename/reorder rooms without touching code.

## Editor vs. Viewer

The two pill buttons in the bottom-left corner are the temporary role switch:

- **Viewer** — just the public site (`/`). Anyone can scroll/scrub/jump nav. No
  edit capability at all.
- **Editor** — opens `/admin/`, a Decap CMS screen. Logging in there is
  gated by Netlify Identity (see setup below), so only invited editors can
  get in. From that screen an editor can:
  - Rename any nav label (renames the room's entry on the walkthrough)
  - Upload a new video and add it as a new room (tags it to the nav automatically)
  - Reorder rooms (drag items in the "Rooms" list)
  - Replace a room's video
  - Edit the property title/address/footer text and the logo link

Saving in the CMS commits straight to `content/rooms.json` (and uploads new
videos into `videos/2209-branch-ave/`) on the `main` branch, which triggers a
Netlify rebuild and republishes automatically.

## 1. Preview locally

Any static file server works, e.g. from this folder:

```bash
npx serve .
# or: python -m http.server 8080
```

Then open the printed localhost URL. (Opening `index.html` directly via
`file://` won't work — `fetch('content/rooms.json')` requires an http server.)

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

- **Scrubbing feel**: this uses native `<video>` seeking eased via
  `requestAnimationFrame`, not a frame-image sequence. It's smooth for these
  short clips; if you use much longer or very high-bitrate source video later
  and scrubbing feels sticky, re-export clips with more frequent keyframes
  (e.g. `-g 15` in ffmpeg). `SCRUB_SENSITIVITY` and `EASE_FACTOR` at the top
  of `assets/js/main.js` control how far one scroll tick moves the video and
  how "floaty" the easing feels — tune those to taste.
- **Cache loader**: all room videos are preloaded (with a real buffering
  progress bar) before the site reveals itself, so the first scrub never
  stalls waiting on the network.
- **Adding another property later**: duplicate the `videos/<slug>/` folder
  and either point `content/rooms.json` at the new clips, or (cleaner, if you
  want multiple properties live at once) copy this whole project per
  property/subdomain — ask and I can wire up a proper multi-property picker
  instead.
