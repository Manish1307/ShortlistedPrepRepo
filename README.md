# ShortlistPrep

AI interview preparation for freshers and job seekers: an ATS resume check, a Skill Gap report for real jobs, and
interview practice from your own resume. This repository holds everything:

| Part | Folder / file | What it is |
|---|---|---|
| Interview Assistant (desktop, Windows) | `main.js`, `renderer/`, `src/` | Live help in an interview: it listens, transcribes offline (Whisper), detects questions and streams an answer into a private window hidden from screen sharing |
| Mock Interview (desktop) | `interview-main.js`, `interview-window.html` | Practise with an AI interviewer; questions are made from your resume |
| ShortlistPrep.AI (desktop) | `shortlistprep-ai-main.js`, `shortlistprep-ai-window.html` | The same engine for teaching over a video call |
| Website | `website/` | The public pages, free sign-up, the Download page and My account |
| Server and admin dashboard | `admin/` | Licence API, accounts, downloads and the admin dashboard (SQLite) |
| Deployment | `deploy/` | Server setup script, systemd service, Caddy config, backups |

All commands, shortcuts and ports are in [SHORTLISTPREP-COMMANDS.txt](SHORTLISTPREP-COMMANDS.txt).
Publishing the server and website: [deploy/README.md](deploy/README.md).

## Setup (Windows)

```bash
git clone https://github.com/Manish1307/ShortlistedPrepRepo.git shortlistprep-app
cd shortlistprep-app
npm install
npm run setup:whisper      # one time: speech engine + small.en model (~190 MB)
npm run web                # website http://localhost:4173 and admin http://localhost:4180
npm start                  # the Interview Assistant
```

Choose an AI service in the assistant's Settings (the gear icon):

- **Groq** (free plan, fastest) or **Google Gemini** (free tier): keys at https://console.groq.com/keys and https://aistudio.google.com/apikey, or set `GEMINI_API_KEY`.
- **Anthropic Claude** (paid API, separate from a Claude Pro subscription): key from https://console.anthropic.com, or set `ANTHROPIC_API_KEY`.

Keys pasted into Settings are stored encrypted with the OS keystore; the app refuses plain-text storage.

## Using it

| Action | Hotkey |
| --- | --- |
| Show / hide the assistant window | Ctrl+Shift+N |
| Start / stop listening | Ctrl+Shift+L |
| Question finished: answer everything heard so far | Ctrl+Shift+A |
| Capture a question from the screen (draw a box; Enter = whole screen) | Ctrl+Shift+Q |
| Capture the whole screen the mouse is on | Ctrl+Alt+Shift+Q |

**Screen capture:** when a student shares a question as a picture, in Notepad or in the chat, press Ctrl+Shift+Q (or
the Capture button) and draw a box around it. The selection screen is hidden from screen sharing like the Notes
window. The selected AI (Gemini, Claude, or a Llama 4 vision model on Groq) copies the question out of the picture and
it is answered in the usual list, code kept in its own block. Pictures stay in memory and are never written to disk.

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
