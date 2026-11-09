
# TipPhone

Rings a Polycom USB desk phone whenever a TipPage tip comes in. Pick up the handset and the TTS plays down the line and on stream, with an optional OBS overlay.

One `.exe`, nothing to install (unless you want to build from source yourself!)

## Setup (for the streamer)

1. Download `TipPhone.exe`, put it in its own folder (it saves its settings next to itself) and double-click it. Windows SmartScreen may warn about an unknown app - More info, Run anyway.
2. Your browser opens the control page at `http://127.0.0.1:4455/`. It needs Chrome, Edge or another Chromium browser (only those can talk to a USB phone and pick audio outputs), and the page should say so if yours cant (🤞). Work down the numbered steps.
3. Step 5, the OBS overlay, is optional. The page walks you through adding a Browser source, says whether OBS has it, and "Run a sample call on it" rings, answers and hangs up on the overlay without touching the queue. The card is TipPage green unless you pick another colour there.
4. Step 6 matters (A LOT!): on your TipPage overlay's alert box, turn tip alerts off. Otherwise the alert box on your overlay plays every tip before the phone gets a chance. Subs, raids and the rest stay on the alert box, see "Alerts and the phone" below.
5. Press **Test call**. It rings with the last played AI-voice tip and leaves the queue alone.

The green band at the top says what TipPhone is doing right now: waiting, a tip whose voice is being made, who's calling, who's on the line and what they said.

Leave the TipPhone window and the browser tab open while streaming. Next time it's just double-click, click Start, since TipPage stays connected. If you close the tab, open `http://127.0.0.1:4455/` again, it is printed at the top of the page too.

TipPhone works with one phone, the polycom cx300 r2 usb desk phone  (USB ids `095d:9201`). The Connect phone list only shows that one, and its hook switch, ringer and screen need no setting up. To try TipPhone without it, see "Trying it without a phone" below.

If the phone doesn't physically ring, the ring still plays as a sound through the earpiece and on stream (both ticked by default). The sound is `src/ring.wav` built into the exe (it loops while ringing, so a few seconds is plenty), or any mp3, wav or ogg chosen under Ring sound in step 4, which is saved next to the exe as `ring.<ext>`.

Close other applications that could be using the phone (Teams etc) first.

## What happens on a tip

1. A tip lands in the TTS queue. Once its audio is ready the phone rings, its screen shows the name and the amount, and the overlay says "{Name} is calling."
2. The handset comes off the hook - TipPhone marks the tip as playing on TipPage via the API, the overlay says "Name is on the phone."
3. One second later the TTS plays through the phone's earpiece and on stream at the same time
4. When it finishes the tip is marked as played and the overlay says the call ended. Put the handset down and the next one can ring.

Hang up and the TTS will be moved to history. Hang up before the voice starts and the tip goes back in the queue and rings again. Skipping from the TipPage dashboard cuts the call. This can be changed, see below.


## Alerts and the phone

Subs, gift subs, resubs, cheers, raids and Kicks keep playing on your alert box. With "Don't ring while an alert is on the overlay" ticked under How calls behave (it is by default), TipPhone stays out of its way:

- A tip is ready and an alert is on screen: the phone waits and rings after it.
- An alert lands mid-call: the alert box holds it until the call ends.

"Wait for an alert for up to" caps all of that, 120 seconds by default, so a stuck alert can't hold a call for good. TipPhone reads what's on screen from `GET /v1/alerts/now` and hears alerts arrive and finish on the event stream (`twitch.*`, `kick.*`, `alert.finished`), all under `tts:read`. Channel-point redemptions are only waited for when the box is showing one; Twitch sends one for every press and most never alert.

## Trying it without a phone

Click **Try it without a phone** under step 3 on the control page. Set Phone in step 4 to your speakers or headphones. The handset is now the Pick up / Hang up button (or the space bar), and everything else runs for real.

- Quick check: **Test call** rings with the last played AI-voice tip (if you have one) and leaves the queue alone.
- The full flow: in the TipPage dashboard use Add manual tip with AI voices on. It joins the queue like a real tip, so you get the ring, the claim, the playback, the finish and the overlay, and it never counts as money.

## OAuth app (once, before building)

TipPhone signs in with TipPage OAuth, so it needs an OAuth app to sign in as. In the TipPage dashboard: Settings, Developer, OAuth apps, register app:

- name: TipPhone
- public client (no secret - it runs on someone's PC, a secret wouldn't stay secret)
- redirect URI: `http://127.0.0.1:4455/callback`
- scopes: `tts:read`, `tts:control`

Put the client id (`oc_...`) in `CLIENT_ID` in `src/oauth.js` and build. `clientId` in `config.json` overrides it, handy while testing. If someone changes `port` the redirect URI changes with it and has to be registered too.

Tokens are saved in `tokens.json` next to the exe. The access token lasts an hour and is refreshed on its own; the refresh token never expires but is replaced every time it's used, so don't copy `tokens.json` between PCs - two copies refreshing will get the connection revoked.

## Settings

`config.json` next to the exe, made on first run. The voice, the timings, the hang-up choices, replays and what the overlay card shows can be changed on the control page (step 5 and "How calls behave") and apply straight away; `port`, `browser` and the overlay titles need a restart after editing the file.

| key | default | |
|---|---|---|
| `port` | `4455` | control page + overlay port |
| `browser` | `"default"` | what opens on start: `default` (the system browser), `edge` (for a PC whose default is Firefox or Safari) or `none` |
| `answerDelayMs` | `1000` | gap between picking up and the voice |
| `ringTimeoutSec` | `0` | stop ringing after this long, 0 rings until answered |
| `missedRetrySec` | `60` | when a missed call rings again |
| `betweenCallsMs` | `3000` | gap before the next call |
| `waitForAudioSec` | `60` | how long a tip waits for its AI voice before the next tip gets to ring first |
| `hangUpBeforeAudio` | `"release"` | `release` puts the tip back, `finish` counts it as played |
| `hangUpDuringAudio` | `"finish"` | same choice for hanging up mid-message |
| `includeReplays` | `false` | ring for replays from the dashboard too |
| `waitForAlerts` | `true` | don't ring while the alert box is showing an alert, hold the voice if one is on screen at pick-up; see "Alerts and the phone" |
| `waitForAlertsSec` | `120` | the longest any of those waits lasts |
| `ringFile` | `null` | the name of a ring sound chosen on the page (the file sits next to the exe as `ring.<ext>`), null = built-in |
| `voice.voice` | `""` | the standard voice a tip is read in; blank = the main alert box's (and its speed and pitch) |
| `voice.rate` / `voice.pitch` | `1` / `1` | 0.5 to 2 and 0.7 to 1.5, only with a voice of TipPhone's own |
| `voice.readNames` / `readAmounts` / `readMessages` | `true` | what the phone reads out |
| `overlay.ringing` | `"{name} is calling."` | `{name}` and `{amount}` work |
| `overlay.onCall` | `"{name} is on the phone."` | |
| `overlay.showAmount` / `showMessage` | `true` | |
| `overlay.endedHoldMs` | `4000` | how long "call ended" stays up |
| `overlay.color` | `"#4ade80"` | the card's colour, picked with the colour picker under step 5; the text picks black or white ink to suit |

## Building

Needs [Bun](https://bun.sh).
```bash
bun run build        # dist/TipPhone.exe, cross-compiles from linux/mac fine
bun run dev          # run it from source
```

On Windows, double-click `build.bat`. It checks Bun is installed and `src/ring.wav` is there, then does the same build.
