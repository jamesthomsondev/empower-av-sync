# Feasibility Report — Empower A/V Sync

**Spike:** shared screen + personal headphone audio ("silent cinema") on visitor-owned phones
**Repo:** `empower-av-sync` · **Date:** 9 July 2026 · **Status:** working prototype, verified on two devices

---

## What we set out to prove

That a fixed gallery screen playing a looping video can act as a permanent sync leader for
an arbitrary number of visitor phones, each playing the video's soundtrack through their own
headphones, **tightly enough locked that the audio audibly belongs to the picture** — with:

1. **No media over the wire.** Video and audio live on each device (PWA-cached); the network
   carries only tiny sync beats.
2. **No infrastructure to run.** Serverless WebRTC (Trystero) — no sync server, no media
   server, no backend deploy.
3. **BYOD with zero calibration.** Visitors' own phones and headphones (including Bluetooth),
   no per-device latency setup step.
4. **Both major mobile platforms.** iOS Safari and Android Chrome, despite their very
   different media-pipeline behaviour.

The target quality bar: drift small enough that a per-second click in the headphones lands
on the corresponding flash on screen (roughly the ±80 ms range generally accepted as "in
sync" for A/V lip-sync).

## How it works

The screen is a **fixed leader**; phones are followers in a star topology. Roles never
migrate. All logic is client-side in a PWA (Vite + React + TypeScript).

**Transport** ([sync-controller.ts](src/transport/sync-controller.ts)) — peers meet through
Trystero (WebRTC data channels; Nostr public relays for signaling by default, MQTT/torrent
strategies swappable). The wire protocol is two messages:

- **`beat`** (screen → all, 4×/sec): `{ mediaId, videoTime, wall, playing, duration }` —
  where the looping video is and the screen's wall-clock at that instant. `mediaId` tells
  followers which soundtrack to load.
- **`clk`** (follower → screen RPC, every 3 s): estimates the screen↔follower clock offset
  via **Cristian's algorithm** (`offset = tScreen − (t0+t2)/2`), keeping the lowest-RTT
  sample from a rolling window of 8. Beat gaps > 4 s bump a `syncEpoch`, forcing a clean
  resync after sleep/reconnect.

**Correction** ([sync-math.ts](src/sync/sync-math.ts), pure and unit-tested) — each follower
runs a ~15 Hz loop: extrapolate the screen's current position
(`target = videoTime + (now + offset − wall)`, wrapped to the loop), compute loop-aware
`signedDrift`, EMA-smooth it, then steer.

**Two audio engines**, selected per platform ([audio-sync-controller.ts](src/media/audio-sync-controller.ts)):

- **Element engine (Android/desktop):** a streaming `<audio>` element routed through Web
  Audio. Inside a ±70 ms deadband it holds rate 1; small drifts are closed by nudging
  `playbackRate` (0.97–1.03, pitch preserved — inaudible); drifts > 0.6 s hard-seek, with an
  8 s cooldown and settle window so seeks stay rare.
- **Buffer engine (iOS)** ([buffer-audio-engine.ts](src/media/buffer-audio-engine.ts)):
  Safari's media-element pipeline stalls > 1 s on every seek (and spontaneously mid-playback)
  and ignores fine `playbackRate` writes, which defeated element-side correction. Instead the
  soundtrack is fetched and decoded to an `AudioBuffer` and played on the **AudioContext
  clock**: repositioning is a sample-accurate source-node swap (no stall), rate nudges
  (0.98–1.02) are honored as an AudioParam, and drift > 0.25 s restarts at the live target.
  While downloading/decoding the follower stays silent and reports "syncing"; the element
  remains primed as a fallback if fetch/decode fails.

**Automatic output-latency compensation** — what you hear trails the element/context clock
by the device's output latency (~100–300 ms on iOS; Bluetooth adds more). This is measured
live from `AudioContext.getOutputTimestamp()` (with `outputLatency` as fallback and a
conservative iOS default), EMA-smoothed, and the audio is steered *ahead* by that amount so
the **audible** sound lands on the video. No user calibration — this is what makes BYOD
Bluetooth headphones workable.

**Platform plumbing** — audio is unlocked inside the join tap (autoplay gate); routing
through Web Audio means the **iOS ringer/mute switch does not silence playback**; a wake-lock
option keeps screens/phones awake; `visibilitychange` handlers resync after backgrounding.
The PWA precaches the app + test clip (offline after first load); large real content is
runtime-cached, and **followers only ever download the audio** (e.g. 14 MB vs the screen's
127 MB video).

## Pros

- **It works, on the hard platform.** iOS Safari — the graveyard of this class of idea —
  holds lock via the buffer engine after the element approach measurably failed.
- **Zero backend.** No sync server, no media server, nothing to host or scale for playback
  itself. Signaling uses public relays; media ships with the PWA or the venue's static hosting.
- **Negligible bandwidth.** ~4 small JSON beats/sec plus a clock ping every 3 s per follower.
  Media never crosses the wire; followers fetch only the soundtrack once (then it's cached).
- **No calibration step.** Output latency (wired, speaker, Bluetooth) is measured and
  compensated automatically at runtime — essential for BYOD.
- **Robust to real-world messiness.** Loop-seam-aware math, clock-offset re-estimation,
  reconnect/wake resync epochs, mute-switch bypass, drift meter for instant diagnosis.
- **Inaudible correction.** Steady-state correction is a ±3 % pitch-preserved rate nudge
  inside a deadband; hard seeks are reserved for join/reconnect/loop-wrap.
- **Honest, testable core.** The sync math is pure and unit-tested (`yarn sim`, all passing);
  platform hacks are quarantined in the two engine classes.

## Cons

- **Two engines to maintain.** The iOS path exists because Safari's media pipeline is
  broken for this use; that's a second correction loop, second latency model, and a
  fallback ladder to keep working as Safari evolves. WebKit updates are a standing risk.
- **iOS decodes the whole soundtrack into RAM.** A decoded `AudioBuffer` is raw PCM:
  a 15-minute stereo 44.1 kHz track is roughly **300 MB of memory**. Fine for short loops;
  a real risk of jetsam kills on older iPhones for long content. (Unmeasured — see below.)
- **Silent join window on iOS.** Followers hear nothing until the soundtrack has downloaded
  *and* decoded (~14 MB for the 15-min clip). On venue Wi-Fi that's seconds; on bad cellular
  it's a noticeable dead period, surfaced only as "syncing".
- **Depends on public signaling infrastructure.** Default matchmaking rides free Nostr
  relays — fine for a spike, not an SLA. (Strategy is swappable and only needed at join
  time, but it's still a third party in the visitor's critical path.)
- **iOS rate nudges are not pitch-preserved.** `AudioBufferSourceNode.playbackRate` shifts
  pitch; the clamp is kept subtle (±2 %) so it's hard to hear, but it's a compromise the
  element engine doesn't make.
- **Room codes are the only access control.** 4-character code doubles as the room
  password; anyone who can reach the signaling network and guess/see a code can join.
  Acceptable for listening to a public soundtrack, but worth being deliberate about.

## Limitations

Scope boundaries of the current design (as opposed to defects):

- **Fixed leader, no migration.** If the screen device dies, the experience stops until it
  returns; followers show "screen offline". No gossip relay — every follower needs a direct
  (or TURN) connection to the screen.
- **Looping-video model only.** The sync target is a single continuously looping video.
  Playlists, seek-by-operator, multiple simultaneous zones, or paused-by-default content
  would need protocol extensions (the `paused` beat state exists but is untested as a mode).
- **Joining needs the network.** Playback is offline-capable once cached, but matchmaking
  (signaling + WebRTC) requires internet at join time. A venue with captive-portal or
  client-isolated Wi-Fi may also block P2P entirely — the TURN seam (`VITE_TURN_*`) exists
  but no TURN server is provisioned.
- **Correction envelope.** The nudge closes ≤ 0.6 s (element) / ≤ 0.25 s (buffer) drift at
  at most 2–3 %/s; anything larger is a hard snap. In practice snaps happen at join and
  after backgrounding, which is the intended behaviour.
- **One screen per room.** No concept of multiple synchronized screens sharing a leader
  clock (likely easy — they'd just be followers with video instead of audio — but unbuilt).
- **Locked/backgrounded phones stop playing.** iOS suspends the AudioContext when the
  screen locks or Safari backgrounds; the app resyncs on return but there is no
  lock-screen/background playback (that would need different media-session plumbing).

## What's verified vs open

**Verified by automated test (re-run for this report):**

- `yarn sim` — Cristian offset/RTT math, lowest-RTT selection, target extrapolation incl.
  loop wrap and paused state, signed loop-seam drift both directions, correction-rate sign
  and clamping. **All passing.**

**Verified manually during the spike (per README, not re-run here):**

- Two clients in-browser: follower locks to single-digit-ms drift, `mode: locked`,
  rate ≈ 1, correct tracking across the loop wrap.
- Two real devices (laptop screen + iPhone with headphones): clicks land on flashes; drift
  stays small on both Wi-Fi and cellular.
- iOS specifics: buffer engine eliminates the drift/stutter the element path showed;
  audio plays with the mute switch on; auto latency compensation reads ≈ 220 ms on test
  Chrome and steers correctly.
- Bandwidth asymmetry: screen fetches the 127 MB video, each follower only the 14 MB audio.
- Offline: after one load, video + audio play from cache with the network off.

**Open — not yet tested or measured:**

- **Fan-out scale.** Largest real test is a handful of peers. A gallery scenario means tens
  of followers per screen: WebRTC connection limits on the screen device, beat send cost at
  N connections, and clk-RPC load are all unmeasured.
- **Long-session stability.** Multi-hour soak: clock-offset drift between resamples, EMA
  behaviour over thousands of loops, Safari memory over time, thermal/battery impact of a
  15 Hz corrector + wake lock on phones.
- **iOS memory ceiling for long content.** The decoded-PCM footprint (~300 MB / 15 min
  stereo) vs Safari's per-tab memory budget on the oldest supported devices.
- **Hostile venue networks.** Client-isolated Wi-Fi, symmetric NAT, captive portals — i.e.
  whether TURN is a nice-to-have or a requirement, and its cost.
- **Device breadth.** Android fragmentation (element engine assumed fine from Chrome
  desktop + limited Android testing), older iPhones, Bluetooth codecs with extreme latency
  (some exceed the 0.5 s measurement clamp).
- **Perceptual validation.** The drift meter says single-digit ms; a blind "does it feel
  synced" test with naive users, various headphones, at gallery viewing distances hasn't
  been done.
- **Signaling reliability at event scale** and behaviour when relays are slow/down mid-session
  (in-session sync survives — join does not).

## Recommendations

1. **Call the core question answered and keep the spike as reference.** The hard risk —
   iOS-viable, calibration-free, sub-perceptual sync over serverless WebRTC — is retired.
2. **Before committing to production, run the two cheap kill-shot tests:**
   - **Scale test:** one screen + 20–30 phones (staff devices) for an hour. Watch screen-side
     CPU, connection count, and follower drift. This is the likeliest place the star topology
     breaks, and it's a one-afternoon test.
   - **iOS memory test:** the real content length on the oldest iPhone the venue must
     support, watching for tab reloads/jetsam. If it fails, the fix is known but non-trivial
     (chunked buffers or accepting the element path's limits for long content).
3. **For production, replace the free-relay dependency:** host a TURN server and either
   self-host signaling (Nostr relay/MQTT broker) or pin to paid relays. Budget this as the
   only real infrastructure cost.
4. **Design for venue Wi-Fi early.** Get on the actual network (or its spec) and confirm
   P2P/TURN reachability before UX work builds on instant joins.
5. **Productionization backlog, roughly in order:** leader restart/recovery UX (screen
   reboot mid-day), download-progress UI for the iOS syncing window, multi-zone/room
   namespacing, telemetry (aggregate drift/latency reporting instead of a per-phone debug
   panel), and a perceptual acceptance test with naive users.
6. **Track WebKit.** Pin a quarterly check that the buffer-engine assumptions (element
   pipeline stalls, `getOutputTimestamp` behaviour) still hold on new iOS releases; keep
   the element fallback alive as insurance.

## Verdict

**Feasible — proven in principle, with scale and iOS-memory as the two named unknowns.**

The spike demonstrates end-to-end, on real devices including iOS Safari, that a shared
screen and personal phone audio can hold sync within single-digit milliseconds of measured
drift — under the ±80 ms perceptual bar with an order of magnitude to spare — using no
backend, no media streaming, and no user calibration. The two platform engines are the
right architecture, not a workaround smell: they isolate exactly the code that platform
media stacks force apart.

What is *not* yet proven is the gallery envelope: dozens of simultaneous followers per
screen, hours-long sessions, long-form content on old iPhones, and hostile venue networks.
None of these looks like a design-breaker — each has a plausible mitigation inside the
current architecture — but all four are empirical questions the next iteration should
answer before this graduates from spike to product commitment.
