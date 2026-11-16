# Using CueStage with Bitfocus Companion

CueStage does not need its own Companion module. Use the two generic modules that ship with Companion:

* **Generic: HTTP Requests** – for buttons *and* for feedback/variables (recommended)
* **Generic: OSC** – for buttons only, if you prefer OSC

Replace `192.168.1.50` with the show machine's IP (shown in CueStage under **Web viewers & remote**).
If you set a controller PIN in CueStage, add `?pin=1234` to every HTTP action URL (or `&pin=1234` if the URL
already has a `?`).

## 1. Buttons with the Generic HTTP module

1. In Companion: **Connections → Add connection → Generic: HTTP Requests**.
2. Set **Base URL** to `http://192.168.1.50:8080`.
3. On a button, add the action **HTTP: GET** and enter one of these in **URI**:

| Button | URI |
|---|---|
| GO | `/api/go` |
| Stop All (fade) | `/api/stop` |
| PANIC | `/api/panic` |
| Standby previous / next | `/api/prev` · `/api/next` |
| Play / pause video | `/api/pause` |
| Fire cue 12 | `/api/cue/12/go` |
| Standby cue 12 | `/api/cue/12/select` |
| Timer start/pause toggle | `/api/timer/toggle` |
| Timer start | `/api/timer/start` |
| Timer pause | `/api/timer/pause` |
| Timer reset | `/api/timer/reset` |
| Next timer | `/api/timer/next` |
| Next timer and start it | `/api/timer/next?start=1` |
| Select timer 3 | `/api/timer/3/select` |
| Start timer 3 | `/api/timer/3/start` |
| +1 minute | `/api/timer/add/60` |
| −1 minute | `/api/timer/add/-60` |
| +5 minutes | `/api/timer/add/300` |
| Message "WRAP UP" | `/api/message?text=WRAP%20UP` |
| Flashing message "TIME UP" | `/api/message?text=TIME%20UP&flash=1` |
| Clear message | `/api/message/clear` |
| Blackout toggle | `/api/blackout/toggle` |

(Spaces in message text must be written as `%20`.)

## 2. Buttons with the Generic OSC module

1. **Connections → Add connection → Generic: OSC**.
2. **Target IP** `192.168.1.50`, **Target port** `53535`.
3. Use these actions:

| Button | Action | OSC path | Value |
|---|---|---|---|
| GO | Send message without arguments | `/go` | |
| Stop All | Send message without arguments | `/stop` | |
| PANIC | Send message without arguments | `/panic` | |
| Fire cue 12 | Send message without arguments | `/cue/12/go` | |
| Timer start | Send message without arguments | `/timer/start` | |
| Timer pause | Send message without arguments | `/timer/pause` | |
| Timer reset | Send message without arguments | `/timer/reset` | |
| Next timer | Send message without arguments | `/timer/next` | |
| Select timer 3 | Send integer | `/timer/select` | `3` |
| +1 minute | Send integer | `/timer/add` | `60` |
| −1 minute | Send integer | `/timer/add` | `-60` |
| Message | Send string | `/message` | `WRAP UP` |
| Clear message | Send message without arguments | `/message/clear` | |
| Blackout on / off | Send integer | `/blackout` | `1` / `0` |

## 3. State on your buttons (variables and feedback)

CueStage exposes a flat JSON document at **`/api/companion`** designed for this.

1. In the **Generic HTTP** connection settings (Companion 3.x), there is no polling by itself, so add a
   **trigger**: **Triggers → Add trigger → Time interval, every 1 second**, with the action
   **HTTP: GET**, URI `/api/companion`, and set **JSON Response Data Variable** to a custom variable,
   e.g. `cuestage` (create it first under **Variables → Custom variables**). Tick **JSON Stringify Result** off
   so the variable holds an object.
2. Use the values in button text with Companion's expression syntax:

| Shows | Button text |
|---|---|
| Timer value | `$(custom:cuestage)` is the whole object – use an expression variable: `jsonpath($(custom:cuestage), '$.timer_display')` |
| Timer title | `jsonpath($(custom:cuestage), '$.timer_title')` |
| Live cue | `concat(jsonpath($(custom:cuestage), '$.live_cue_number'), ' ', jsonpath($(custom:cuestage), '$.live_cue_name'))` |
| Remaining on live cue | `jsonpath($(custom:cuestage), '$.live_remaining')` |
| Standby cue | `jsonpath($(custom:cuestage), '$.standby_cue_name')` |

   (Set the button text field to **expression mode** – the small `$x` toggle next to the text box.)

3. Colour feedback: add the built-in feedback **Internal: Check expression** (or *Variable: Check value*)
   and change the button style when the expression is true:

| Button turns… | Expression |
|---|---|
| Green while the timer is green | `jsonpath($(custom:cuestage), '$.timer_colour') == 'green'` |
| Amber | `jsonpath($(custom:cuestage), '$.timer_colour') == 'amber'` |
| Red at/after the red threshold or zero | `jsonpath($(custom:cuestage), '$.timer_colour') == 'red' \|\| jsonpath($(custom:cuestage), '$.timer_colour') == 'over'` |
| Lit while a cue is playing | `jsonpath($(custom:cuestage), '$.playing') == true` |
| Lit while video is paused / held | `jsonpath($(custom:cuestage), '$.paused') == true` |
| Lit while the timer runs | `jsonpath($(custom:cuestage), '$.timer_running') == true` |
| Warning when blackout is on | `jsonpath($(custom:cuestage), '$.blackout') == true` |

Menu names differ slightly between Companion versions; the URLs, OSC paths and JSON keys above do not.

### All keys in `/api/companion`

`live_cue_number`, `live_cue_name`, `live_cue_state`, `live_elapsed`, `live_remaining`, `live_remaining_seconds`,
`standby_cue_number`, `standby_cue_name`, `playing`, `paused`, `running_cues`, `timer_title`, `timer_speaker`,
`timer_display`, `timer_colour`, `timer_running`, `timer_state`, `timer_remaining_seconds`, `timer_next_title`,
`message`, `blackout`, `schedule_offset_seconds`, `clock`, `rehearsal`, `locked`.

For push updates instead of polling, connect a WebSocket client to `ws://192.168.1.50:8080/ws`
(see [API.md](API.md)).
