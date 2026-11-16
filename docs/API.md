# CueStage remote control API

CueStage runs a small web server on the show machine (default port **8080**) and an OSC listener
(default UDP port **53535**). Both are configurable in **Settings → Network**. The exact addresses for
your machine are shown in the console under **Web viewers & remote**.

In the examples, replace `192.168.1.50` with the show machine's IP address.

## Web viewers

| View | URL | Purpose |
|---|---|---|
| Stage / presenter | `http://192.168.1.50:8080/stage` | Big timer, label, next item, messages, colour state. Tap/click for fullscreen. |
| Controller | `http://192.168.1.50:8080/controller` | Phone/tablet page to run timers and send messages (optional PIN). |
| Agenda | `http://192.168.1.50:8080/agenda` | Full rundown, planned vs actual, ahead/behind. |

## HTTP API

Every control endpoint accepts **GET or POST** (so it works from a browser address bar, `curl`, Companion
or a Stream Deck "open URL" action). Responses are JSON: `{"ok":true,"command":"go"}`.

If a **controller PIN** is set, add `?pin=1234` (or send an `X-Pin: 1234` header) to every control call.
Reading state never needs the PIN.

### Cues

| Endpoint | Action |
|---|---|
| `/api/go` | GO – fire the standby cue (same as the space bar) |
| `/api/stop` | Stop All with the show's fade time |
| `/api/panic` | Instant hard stop of everything |
| `/api/prev` · `/api/next` | Move the standby (playhead) up / down |
| `/api/pause` | Play / pause the live video (also plays a video held on its first frame) |
| `/api/cue/{number}/go` | Fire the cue with that cue number, e.g. `/api/cue/12/go`, `/api/cue/4.5/go` |
| `/api/cue/{number}/select` | Make that cue the standby cue without firing it |
| `/api/cue/{number}/stop` | Stop that cue (uses its fade-out time if it has one) |

### Timers

| Endpoint | Action |
|---|---|
| `/api/timer/start` | Start / resume the current timer |
| `/api/timer/pause` | Pause |
| `/api/timer/toggle` | Start if stopped, pause if running |
| `/api/timer/reset` | Reset the current timer |
| `/api/timer/next` · `/api/timer/prev` | Select the next / previous timer in the rundown (`/api/timer/next?start=1` also starts it) |
| `/api/timer/add/60` | Add 60 seconds (any number; negative subtracts: `/api/timer/add/-300`) |
| `/api/timer/subtract/60` | Subtract 60 seconds |
| `/api/timer/{n}/select` | Select timer number *n* in the rundown (1 = first). A timer id also works. |
| `/api/timer/{n}/start` | Select timer *n* and start it |

### Messages and blackout

| Endpoint | Action |
|---|---|
| `/api/message?text=WRAP%20UP` | Show a message on the stage display. Options: `&flash=1`, `&bold=0` |
| `/api/message/clear` | Clear the message |
| `/api/blackout/on` · `/api/blackout/off` · `/api/blackout/toggle` | Black out the timer screens |

POST bodies may be JSON instead of query strings, e.g.
`curl -X POST http://192.168.1.50:8080/api/message -d '{"text":"5 MINS","flash":true}'`.

### State

| Endpoint | Returns |
|---|---|
| `/api/state` | Full state: live and standby cue, all running cues, the timer rundown with planned/actual times, message, blackout |
| `/api/companion` | The same information flattened into simple keys (below), ideal for Companion variables |

`/api/companion` example:

```json
{
  "live_cue_number": "3", "live_cue_name": "Opening film", "live_cue_state": "running",
  "live_elapsed": "0:42", "live_remaining": "1:18", "live_remaining_seconds": 78,
  "standby_cue_number": "4", "standby_cue_name": "Walk-on sting",
  "playing": true, "paused": false, "running_cues": 2,
  "timer_title": "Keynote", "timer_speaker": "Ann Lee", "timer_display": "12:30",
  "timer_colour": "green", "timer_running": true, "timer_state": "running",
  "timer_remaining_seconds": 750, "timer_next_title": "Panel",
  "message": "", "blackout": false, "schedule_offset_seconds": 95,
  "clock": "14:03:22", "rehearsal": false, "locked": true
}
```

* `live_cue_state`: `idle`, `prewait`, `loading`, `held` (on first frame), `running`, `paused`, `holding` (on last frame), `fading`
* `timer_colour`: `idle`, `green`, `amber`, `red`, `over` (at or past zero)
* `schedule_offset_seconds`: positive = running behind, negative = ahead, empty = unknown

## WebSocket (live state)

Connect to `ws://192.168.1.50:8080/ws`. The server pushes
`{"type":"state","state":{…same as /api/state…}}` on every change and at least twice a second.

Commands can be sent on the same socket:

```json
{"cmd":"timer.add","args":{"seconds":60},"pin":"1234"}
```

Command names: `go`, `stop`, `panic`, `prev`, `next`, `transport.toggle`, `cue.go` / `cue.select` / `cue.stop`
(`{"number":"12"}`), `timer.start` / `timer.select` (`{"id":2}`), `timer.pause`, `timer.toggle`, `timer.reset`,
`timer.next`, `timer.prev`, `timer.add` (`{"seconds":-60}`), `message.send` (`{"text":"…","flash":false,"bold":true}`),
`message.clear`, `blackout` (`{"on":true|false|"toggle"}`).

## OSC

Send OSC over UDP to the show machine on port **53535**. OSC has no PIN – keep it on a trusted show network
(set the port to 0 in Settings to turn it off).

| Address | Arguments | Action |
|---|---|---|
| `/go` | – | GO |
| `/stop` | – | Stop All (fade) |
| `/panic` | – | Hard stop |
| `/prev` · `/next` | – | Move standby |
| `/pause` | – | Play / pause live video |
| `/cue/{number}/go` | – | Fire cue by number, e.g. `/cue/12/go` |
| `/cue/go` | string or number | Fire cue by number passed as the argument |
| `/cue/{number}/select` · `/cue/{number}/stop` | – | Standby / stop that cue |
| `/timer/start` · `/timer/pause` · `/timer/toggle` · `/timer/reset` · `/timer/next` · `/timer/prev` | – | Timer transport |
| `/timer/add` | int seconds | Add time (negative subtracts) |
| `/timer/subtract` | int seconds | Subtract time |
| `/timer/select` | int (1 = first) | Select a timer |
| `/timer/{n}/start` · `/timer/{n}/select` | – | Start / select timer *n* |
| `/message` | string, [int flash], [int bold] | Send a message |
| `/message/clear` | – | Clear the message |
| `/blackout` | int 1/0 (omit to toggle) | Timer blackout |
