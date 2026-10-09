# Teacher Notes

A two-window Electron app for teaching over a video call:

- **Teaching Content** window: the one you share on screen.
- **Notes** window: private, excluded from screen capture. It listens to the meeting audio, transcribes it offline
  (Whisper), detects questions, and streams an answer from Claude into the same private window.

## Setup (Windows)

```bash
npm install
npm run setup:whisper      # one time: speech engine + small.en model (~190 MB)
npm start
```

Choose an AI service in the Notes window's Settings (⚙):

- **Google Gemini** (default, has a free tier): get a key at https://aistudio.google.com/apikey, or set `GEMINI_API_KEY`.
- **Anthropic Claude** (paid API, separate from a Claude Pro subscription): key from https://console.anthropic.com, or set `ANTHROPIC_API_KEY`.

Keys pasted into Settings are stored encrypted with the OS keystore; the app refuses plain-text storage.

## Using it

| Action | Hotkey |
| --- | --- |
| Show / hide the Notes window | Ctrl+Shift+N |
| Start / stop listening | Ctrl+Shift+L |
| Question finished: answer everything heard so far | Ctrl+Shift+A |

Set the **audio source** in Settings: *Meeting audio* (system loopback, Windows only: Teams, Skype, Google Meet,
anything you hear) or *Microphone*. Fill in the **subject**: it is passed to Whisper as a hint and to Claude as context,
and measurably improves accuracy on subject vocabulary.

## Speech accuracy and speed

Measured on this PC with clean Windows text-to-speech (10 classroom sentences, 99 words):

| Setup | Accuracy | Speed (x real time) |
| --- | --- | --- |
| small.en, no subject hint | 94.9% | ~0.8 |
| small.en, subject hint, `-ac 768` (default) | 98.0% | 0.41 |
| medium.en, subject hint | 98.0% | 3.4 (too slow for live use) |

Clean synthetic speech is easier than a real call. Measure with your own recording:

```bash
npm run test:stt -- --wav my.wav --ref "the exact words that were spoken" --topic "your subject"
```

## Tests

```bash
npm test          # unit tests (VAD, question detection, pipeline)
npm run smoke     # opens the windows, checks wiring, exits
```

## Privacy

Audio is transcribed locally and never leaves your PC. Only the text of detected questions (plus the subject and
a little recent context) is sent to the selected AI service (Google or Anthropic). On Google's free tier, prompts may be used to improve their products; use a paid key if that matters. If students' voices are in the meeting, make sure
recording/transcribing is allowed by your school or platform policy.
