# ShortlistPrep

AI interview preparation for freshers and job seekers: an ATS resume check, a Skill Gap report for real jobs, and
interview practice from your own resume. This repository holds everything:

| Part | Folder / file | What it is |
|---|---|---|
| ShortlistPrep.AI (desktop, Windows) | `shortlistprep-ai-main.js`, `shortlistprep-ai-window.html` | Live help in an interview: it listens, transcribes offline (Whisper), detects questions and streams an answer based on your resume |
| Mock Interview (desktop, Windows) | `interview-main.js`, `interview-window.html` | Practise with an AI interviewer; questions are made from your resume |
| Website | `website/` | The public pages, free sign-up, the Download page and My account |
| Server and admin dashboard | `admin/` | Licence API, accounts, downloads and the admin dashboard (SQLite) |
| Deployment | `deploy/` | Server setup script, systemd service, Caddy config, backups |

All commands and ports are in [SHORTLISTPREP-COMMANDS.txt](SHORTLISTPREP-COMMANDS.txt).
Publishing the server and website: [deploy/README.md](deploy/README.md).

## Setup (Windows)

```bash
git clone https://github.com/Manish1307/ShortlistedPrepRepo.git shortlistprep-app
cd shortlistprep-app
npm install
npm run setup:whisper      # one time: speech engine + small.en model (~190 MB)
npm run web                # website http://localhost:4173 and admin http://localhost:4180
npm run shortlistprep-ai   # or: npm run interview
```

Choose an AI service in the app's Settings (the gear icon):

- **Groq** (free plan, fastest) or **Google Gemini** (free tier): keys at https://console.groq.com/keys and https://aistudio.google.com/apikey, or set `GEMINI_API_KEY`.
- **Anthropic Claude** (paid API, separate from a Claude Pro subscription): key from https://console.anthropic.com, or set `ANTHROPIC_API_KEY`.

Keys pasted into Settings are stored encrypted with the OS keystore; the app refuses plain-text storage.

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
npm test          # unit tests
```

## Privacy

Audio is transcribed locally and never leaves your PC. Only the text of detected questions (plus your resume topics and a little recent context) is sent to the AI service.
