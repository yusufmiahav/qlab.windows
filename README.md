# CueStage

Show control for conferences and corporate events on Windows 10/11: a QLab-style audio/video cue list
combined with a Stagetimer-style countdown system, LAN web viewers and a remote-control API.

* Operator console on screen 1, fullscreen presentation output on any other display
* Frame-accurate playback of practically any codec through bundled **mpv**
* Video cues that go live on their **first frame** and can **hold their last frame**
* Playlists, fades, groups, waits, audio cues with per-cue device routing
* Timer rundown with amber/red thresholds, overrun, messages, blackout, overlay on the output
* Stage, controller and agenda web pages for any phone, tablet or laptop on the network
* HTTP, WebSocket and OSC control, with ready-made [Bitfocus Companion recipes](docs/COMPANION.md)

---

## Getting the .exe

Every push to this repository is built on a Windows machine by GitHub Actions.

1. Open the repository on GitHub → **Actions** → the latest **Build Windows app** run.
2. Download the **CueStage-Windows** artifact (a zip) at the bottom of the run page.
3. Inside are two files:
   * `CueStage-Setup-x.y.z.exe` – normal installer (Start menu entry, `.cuestage` file association)
   * `CueStage-Portable-x.y.z.exe` – single file, runs from a USB stick without installing

Pushing a tag such as `v1.0.0` also publishes both files as a GitHub **Release**.

The app is not code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time:
click **More info → Run anyway**. Windows Firewall will ask to allow network access – allow it on
**Private** networks, otherwise the web viewers and remote control cannot connect.

## Building it yourself (Windows)

Requires [Node.js 22](https://nodejs.org) and 7-Zip on the PATH.

```bash
npm ci
```

```bash
npm run fetch-mpv
```

```bash
npm start
```

```bash
npm run dist
```

`fetch-mpv` downloads the current 64-bit mpv build into `vendor/mpv`; `dist` writes the installer and
portable exe to `dist/`. `npm test` runs the unit tests.

---

## Operator quick start

### 1. Set up the output

Plug in the projector/LED processor as an extended display. CueStage puts the output fullscreen on the
first non-primary display automatically; choose another one in **Settings → Output display**. The
line under the preview shows **OUTPUT LIVE**. With only one display connected (or in
**Rehearsal** mode) the picture appears inside the console's preview box instead, and nothing reaches
the audience – handy for building a show on a laptop. A display plugged in later is picked up automatically.

Pick the holding colour or image (what the audience sees when nothing is playing) in **Settings**.

### 2. Build the cue list

* **Drag media files from Explorer** into the cue list – videos, audio and images become cues.
* Or use the **Add** buttons: Video, Audio, Image, Colour, Playlist, Timer, Wait, Fade, Stop, Group, Memo.
* Click a cue to edit it in the **Inspector**. Ctrl/Shift-click selects several. Drag rows to reorder;
  drop onto a Group to put cues inside it. Ctrl+D duplicates, Delete removes, Ctrl+Z / Ctrl+Y undo/redo.
* The green ▶ marks the **standby** cue. Move it with ↑ / ↓, by double-clicking a row or clicking its left edge.

### 3. Run the show

| Key | Action |
|---|---|
| **Space** | **GO** – fire the standby cue |
| **Esc** | Stop All with a fade · press **twice** for an instant hard stop |
| ↑ / ↓ | Standby previous / next cue |
| P | Play / pause the live video |
| , / . | Frame step back / forward |
| E | Jump to 10 s before the end (rehearsals) |
| R | Jump to the start |
| T | Timer start / pause · `[` `]` previous / next timer · `-` `=` ∓1 minute · B blackout · M clear message |

All shortcuts can be changed in **Settings → Keyboard shortcuts**.

**How video cues behave**

* *On GO → Load to first frame* (default): the first GO puts the video on screen, paused on frame 1.
  The cue stays in standby; **GO again** (or P) plays it. Choose *Play immediately* to skip the hold.
* *At end*: **Hold last frame**, **Stop to holding graphic**, or **Auto-advance** to the next cue.
* The standby video is pre-loaded in the background (status bar shows **● LOADED**), so GO is instant.
* In/out points, loop count, volume, fade in/out and audio device are per cue.

**Playlists** play clips in order with a cut or crossfade. Each clip can *continue* or *hold* at its end;
while a playlist is the standby cue, **GO steps to the next clip**.

**Fade cues** target another cue: fade its volume and/or opacity to a level over a time, and optionally
stop it. Select a cue first, then **Add → Fade** to target it automatically. **Stop cues** work the same way.

**Continue modes**: *auto-continue* fires the next cue as soon as this one starts (after the post-wait);
*auto-follow* fires it when this one finishes.

### 4. Timers

The **Timers** panel is the speaker-timer rundown. Add a timer per agenda item (title, speaker, duration).

* Modes: countdown, count up, countdown to a time of day ("ends at 14:30"), time-of-day clock.
* **Auto-start at** a clock time, or **link** a timer so it starts when the previous one ends.
* Click a row to select it, double-click to start. Start/Pause, Reset, Prev/Next, ±1m, ±5m or a custom amount.
* Amber/red thresholds per timer, flash at zero, optional overrun shown as negative time in red.
* **Messages**: type or tap a preset to put text on the stage display; Flash/Bold; Clear removes it.
* **Blackout** blanks every timer screen without stopping the timer.
* **Timer on presentation output**: show the timer as a corner overlay or fullscreen on the main output.
* A **Timer cue** in the cue list can start/pause/reset timers as part of the show.

### 5. Web viewers and remote control

Open **Web viewers & remote** at the bottom of the console for QR codes and addresses:

* **/stage** – confidence monitor view (tap for fullscreen)
* **/controller** – run timers and send messages from a phone (set a PIN in Settings if needed)
* **/agenda** – full rundown, planned vs actual, minutes ahead/behind

Every device must be on the same network as the show machine. Endpoints for Companion, Stream Deck,
OSC and scripts are in [docs/API.md](docs/API.md) and [docs/COMPANION.md](docs/COMPANION.md).

### 6. Before doors

* **Check show** – finds missing media, broken fade/stop targets, disconnected audio devices, duplicate numbers.
* **Rehearsal** – run everything without sending pictures to the presentation screen (audio still plays).
* **Lock** (Ctrl+L) – blocks editing so nothing can be changed by accident; running the show still works.
* **File → Collect show** – copies the show file and all media into one folder for another machine.

### Show files and safety nets

* A show is one `.cuestage` file (JSON). Media paths are stored relative to it, so keeping the show file
  and media in one folder makes it portable.
* Unsaved changes are autosaved every 15 seconds. After a crash or power cut the app offers to recover them.
* Every cue fired and timer action is written to the **Show log** (bottom panel, **Export CSV**), and to a
  daily CSV in `%APPDATA%\CueStage\logs`.
* If a player process ever crashes it is restarted automatically; the rest of the show keeps running.

---

## Things to know

* **Video-to-video crossfades** dissolve from a frozen frame of the outgoing clip into the incoming clip.
  At the end of a clip (the usual playlist case) this is indistinguishable from a true crossfade; mid-clip
  the outgoing picture freezes for the length of the dissolve.
* **One main picture at a time.** A new video, image, colour or playlist cue replaces the one on screen
  (cut, or dissolve using the new cue's fade-in). Audio cues are independent and can overlap freely.
* **Alpha video over other content** uses the *Overlay* layer (Inspector → Layer) and needs WebM with alpha.
  Convert a ProRes 4444 file with:

  ```bash
  ffmpeg -i lowerthird.mov -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 6M -an lowerthird.webm
  ```

  Overlay-layer audio always plays on the Windows default device.
* **Audio devices** are WASAPI devices as Windows lists them (USB interfaces, Dante Virtual Soundcard,
  HDMI…). ASIO is not supported. Set the defaults for video sound and audio cues in Settings; override per cue.
* Loops that use an in-point re-seek at the loop point and are not sample-seamless; loops of a whole file are.
* The live preview thumbnail is a screen grab of the output display about once a second.

## Architecture

```
main/        Electron main process
  main.js      wiring, console window, IPC, dialogs
  show.js      show document, undo/redo, save/load, autosave, collect
  engine.js    cue engine (GO, playhead, waits, fades, groups, playlists, preload)
  output.js    output window stack + transitions
  player.js    one mpv instance as a cue player    mpv.js   mpv process + JSON IPC
  audio.js     pool of audio players, device list
  timers.js    timer rundown engine                log.js   show log / CSV
  server.js    HTTP API + WebSocket + static web viewers    osc.js   OSC server
renderer/
  console/     operator console (Preact, no build step)
  output/      stage (hold + stills), overlay (timer, messages, fade curtain), video host
web/         stage, controller and agenda pages served to the LAN
docs/        API.md, COMPANION.md
```

The presentation output is a stack of borderless always-on-top windows on the output display: a stage
window (holding graphic and stills), two video windows each hosting an mpv instance, and a transparent
overlay window (timer, messages and the "curtain" used for fades). The standby video is loaded, paused
on its first frame, in the video window that is currently hidden behind the stage, so going live is only
a change of window order.

## Licence

CueStage is licensed under GPL-3.0-or-later. It bundles [mpv](https://mpv.io) (GPL/LGPL) as a separate
executable.
