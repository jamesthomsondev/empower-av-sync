# Empower — A/V Sync (feasibility spike)

A **fixed screen plays a looping video** and acts as a permanent leader, continuously
broadcasting its playback clock over WebRTC so **joining phones keep their local audio
tightly locked to the video** ("shared screen + personal headphone audio"). Media is
device-local (PWA-cached); the wire carries only tiny sync beats — never audio/video.

Sibling of `empower-peer-to-peer` (reuses its Trystero transport + PWA/offline patterns),
but with a purpose-built continuous sync engine instead of the gallery's event model.

**Stack:** Vite 7 · React 18 · TypeScript · `vite-plugin-pwa` (offline) · `trystero`
(serverless WebRTC) · Yarn 4 · Node 24.13.0.

## Run

```bash
nvm use && corepack enable
yarn install
yarn dev          # → http://localhost:3100
```

| Command | What it does |
|---|---|
| `yarn dev` | Dev server on :3100 (no service worker) |
| `yarn build` | Type-check + production build (builds the SW) |
| `yarn preview` | Serve the prod build on :4273 (SW active — for offline testing) |
| `yarn sim` | Unit checks for the sync math (`test/sync-sim.ts`) |

## Try it

1. On the display device, open the app, **pick a video** from the dropdown, and tap
   **📺 Be the screen** (starts the looping video and shows a room code + QR).
2. On phones, scan the QR / enter the code and tap **🎧 Join** (the tap unlocks audio on iOS).
   Put on headphones — the phone's audio locks to the video, and a live **drift meter**
   shows how far off it is (ms).

The test clip has a **per-second flash + click** and a sweeping bar, so drift is instantly
visible and audible: the click in your headphones should land on the flash on screen.

## How the sync works

- **`beat`** (screen → all, ~4×/sec): `{ videoTime, wall, playing, duration }` — where the
  video is and the screen's wall-clock at that instant.
- **`clk`** (follower → screen RPC): estimates the **clock offset** between devices via
  Cristian's algorithm (`offset = tScreen − (t0+t2)/2`), keeping the lowest-RTT sample.
- **Corrector** (~15 Hz on each follower): computes the screen's current position
  `target = videoTime + (now + offset − wall)`, wrapped to the loop; measures loop-aware
  `signedDrift(local, target)`; then **nudges `playbackRate`** (pitch preserved, 0.94–1.06)
  to hold sync, **hard-seeking** only on large drift or a loop wrap.

Pure, tested logic is in `src/sync/sync-math.ts`; transport in
`src/transport/sync-controller.ts`; the follower audio corrector in
`src/media/audio-sync-controller.ts`.

## Verification

- **`yarn sim`** — offset/target/drift/rate math incl. the loop seam. All pass.
- **Live (two clients in-browser):** follower locks to the screen's video at **single-digit-ms
  drift**, `mode: locked`, `playbackRate ≈ 1`, tracking correctly across a loop wrap; the
  screen shows the listener count.
- **Offline:** `yarn build && yarn preview`, load once, go offline, reload — video + audio
  play from cache (precache includes `screen.mp4` + `soundtrack.m4a`). Only *joining* needs
  the network.
- **Two-device (manual):** laptop = screen, phone (headphones) = follower — clicks line up
  with flashes; drift stays small on WiFi and cellular (enable TURN via `VITE_TURN_*` if a
  direct connection can't form).

## Videos & adding your own

The leader picks the video from a dropdown; the choice is broadcast in each beat (`mediaId`)
so followers load the matching audio. Two options ship (`src/content/index.ts`):

| id | Video (screen) | Audio (followers) | Bundling |
|---|---|---|---|
| `test` | synthetic clip, flash+click cues (20s) | `soundtrack.m4a` | committed, **precached** (offline) |
| `soh` | `public/media/soh.mp4` (~127 MB H.264) | `public/media/soh.m4a` (~14 MB) | git-ignored, **runtime-cached** |

**Followers only ever download the audio** — verified: the screen fetches `/media/soh.mp4`,
each follower fetches only `/media/soh.m4a` (~14 MB vs 127 MB). The big video is deliberately
kept out of the precache (it lives under `public/media/`, not `static/`).

To add your own video, drop a browser-friendly **H.264/AAC** MP4 + its extracted audio into
`public/media/` and add an entry to `VIDEOS`. From a source file:

```bash
# audio the followers play (stream-copy the AAC → identical timeline, tiny download):
ffmpeg -i source.mov -vn -c:a copy public/media/mine.m4a
# video the screen plays — transcode to H.264 if the source is HEVC/H.265 (Chrome can't decode HEVC):
ffmpeg -i source.mov -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -c:a copy -movflags +faststart public/media/mine.mp4
```
(If the source is already H.264/AAC, remux instead: `ffmpeg -i source.mp4 -c copy public/media/mine.mp4`.)
Keep the audio a stream-copy of the video's own track so their timelines match exactly.

## Notes & limits

- **iOS audio / the ringer switch:** a bare `<audio>` element is "ambient" audio on iOS and
  is silenced by the physical mute switch and silent mode (playback still advances — you'd
  see the drift move but hear nothing). We route the follower's element through the **Web
  Audio API** (`createMediaElementSource → destination`, context resumed in the join tap),
  which plays regardless of the mute switch. The debug panel's `audio out` row shows
  `web-audio (mute-switch safe)` when this is active. AAC/m4a itself is natively supported
  on iOS — format is not the issue.
- The follower's `soundtrack.m4a` is a **stream-copy of the video's own AAC**, so their
  timelines are bit-identical (no encoder-delay offset).
- Fixed leader (no migration); star topology (no gossip relay). Swap the Trystero strategy
  with `VITE_TRYSTERO_STRATEGY`; STUN is on, TURN is a `VITE_TURN_*` seam.
- Same-network tests show ~0 ms clock offset; across real devices the offset estimate
  (NTP-class clocks + RTT compensation) is what keeps drift small — the instrument to watch
  is the follower's drift meter.
- Add or swap videos via the dropdown + `VIDEOS` in `src/content/index.ts` — see
  "Videos & adding your own" above.
- Large real videos (e.g. `soh`) are HEVC-transcoded to H.264 for browser compatibility and
  kept in git-ignored `public/media/`; `yarn build` copies them into `dist/` (large), while
  `yarn dev` serves them in place. The committed `test` clip is what stays offline-guaranteed.
```
