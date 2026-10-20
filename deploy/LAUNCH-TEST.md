# Launch test: deploy the new version and test it with 10–20 real candidates

This kit has four parts. Do them in order; each has a checklist you can tick.

| Part | What | Time |
|---|---|---|
| A | Deploy the new version to the server | 30–45 min |
| B | Your own smoke test on the live site | 30 min |
| C | Pilot with 10–20 real candidates | 1–2 weeks |
| D | Feedback form and what to measure | — |

---

## A. Deploy the new version

### A1. Before you start
- [ ] **Download a backup to your PC.** In the VM's SSH window:
  ```bash
  sudo -u classcue /opt/classcue/backup.sh
  sudo cp /opt/classcue/backups/classcue-*.tgz ~ && sudo chown $USER ~/classcue-*.tgz
  ```
  Then **Download file** (top right of the SSH window). Keep it until the pilot is over.
- [ ] Make sure the PR branch is what you want to ship (`feature/screen-capture-and-ask-tools`), and run the tests on your PC:
  ```bash
  npm test
  ```
  All tests must pass.

### A2. Build and upload
- [ ] On your PC, in the project folder:
  ```bash
  npm run server:package
  ```
  This builds the website and creates `dist\classcue-server.tgz` (server + website).
- [ ] In the VM's SSH window, delete the old package first (otherwise the upload is renamed `classcue-server(1).tgz`):
  ```bash
  rm -f ~/classcue-server*.tgz
  ```
- [ ] Upload `dist\classcue-server.tgz` with **Upload file**.

### A3. Install
- [ ] In the SSH window (use the same three addresses as last time: API, admin, website):
  ```bash
  rm -rf ~/admin ~/deploy ~/site
  tar -xzf classcue-server.tgz
  sudo bash deploy/setup.sh api.34-61-176-96.sslip.io <your admin address> shortlistprep.com
  ```
  The database, signing key and AI keys are kept. New tables (job searches, activity, tokens, saved plans) are created on start.
- [ ] Check the server is running and healthy:
  ```bash
  sudo systemctl status classcue-admin --no-pager
  curl -s https://api.34-61-176-96.sslip.io/api/health
  ```
  The second command must print `{"ok":true}`.
- [ ] If something is wrong, read the log: `sudo journalctl -u classcue-admin -n 100 --no-pager`

### A4. Settings in the admin dashboard (before anyone signs in)
- [ ] **AI keys:** a working default key. For the pilot, a **paid** key (Gemini Tier 1 or Claude) is strongly recommended; the free keys run out after a few dozen AI actions a day for everyone.
- [ ] **AI tokens → Daily allowance:** for the pilot, 100,000 tokens a day per candidate (about 10 career actions); warn at 80%.
- [ ] **AI tokens → Token packs:** add at least one pack (for example "Booster: 2 lakh extra tokens, ₹99") so the "Get more tokens" form has something to offer.
- [ ] **Jobs → Master Prompt:** read it once; the default is fine.
- [ ] **Google Cloud → Billing → Budgets & alerts:** a budget alert (for example $30) so nothing surprises you.

---

## B. Your own smoke test (on the live site, as a candidate)

Create a test login for yourself (Customers → a customer → Website login → Create login), then on **shortlistprep.com**:

| # | Check | OK? |
|---|---|---|
| 1 | Home page loads with the new hero, the Skill Gap section and the journey tabs; nothing looks broken on your phone | ☐ |
| 2 | Sign in. The menu shows **Career toolkit** and **My account**, not Sign in | ☐ |
| 3 | The token meter shows at the bottom of the page | ☐ |
| 4 | Career toolkit → upload a resume (PDF and Word) | ☐ |
| 5 | ATS check: score, checks and an improved resume; **Download .docx** opens in Word | ☐ |
| 6 | Create one role-based resume and download it | ☐ |
| 7 | Job match: paste a job description; get a score and a cover letter | ☐ |
| 8 | AI Job search with country **India** and no companies: results in high / medium / low groups within about 2 minutes | ☐ |
| 9 | Each job shows its **Skill Gap Matrix**; clicking a row opens **Prepare** at that gap | ☐ |
| 10 | Prepare: matrix, gaps with learning links (open a YouTube and a Microsoft Learn link), plan, questions | ☐ |
| 11 | **Apply ↗** opens the company's own job page | ☐ |
| 12 | Get more tokens → send a request; approve it in the dashboard; the extra tokens appear | ☐ |
| 13 | Admin → **Candidates**: your progress, documents (download them), searches, plans and activity | ☐ |
| 14 | Admin → **AI tokens**: today's tokens and your request | ☐ |
| 15 | Sign out: the menu shows Sign in again | ☐ |

Fix anything that fails before inviting candidates.

---

## C. Pilot with 10–20 real candidates

### C1. Who to invite
A mix gives the most useful feedback:
- 5–8 **experienced IT people** (5+ years), for example from your network
- 3–5 **freshers or early-career** candidates (0–2 years)
- 2–4 **non-IT or career changers**
- At least a few who are **actively applying now** (they will use it for real)

### C2. Set up each candidate
- [ ] Admin → Customers → **+ New customer** (email, name).
- [ ] Open the customer → **Website login → Create login** → **Copy message** and send it to the candidate.
  The message has the address, their email and a one-time password; they choose their own password at first sign-in.

### C3. Message to send with the login
> Hi {name}, thank you for helping us test ClassCue, our AI co-pilot for the job hunt.
> Please spend about 30–40 minutes on it this week, as if you were applying for jobs for real:
> 1. Sign in and upload your latest resume (Career toolkit).
> 2. Run the ATS check and download the improved resume.
> 3. Make one resume for a role you want.
> 4. Run an AI Job search for the city and role you want.
> 5. Open the Skill Gap Matrix of one or two jobs and press Prepare.
> 6. If you find a job you like, apply through the Apply link.
> Then fill in the short feedback form: {form link}
> Your resume stays private and is only used to create your documents. Thank you!

### C4. What to watch during the pilot (10 minutes a day)
- [ ] **Candidates page:** who signed in, who uploaded a resume, where people stop (the progress dots show the step).
- [ ] **AI tokens page:** tokens used today, anyone running out, requests waiting.
- [ ] **Server memory** (in the SSH window): `free -h`. If "used" is near the total and swap keeps growing, move the VM to e2-small.
- [ ] **Errors:** `sudo journalctl -u classcue-admin -n 50 --no-pager | grep -i error`
- [ ] Message anyone who signed in but stopped, and ask why (that is the most valuable feedback).

### C5. At the end of the pilot
- [ ] Read the feedback form answers and the Candidates page together.
- [ ] Ask the 3–5 happiest candidates for a short review or testimonial you may publish (with their written OK).
- [ ] Make a list: must fix before launch / nice to have / ignore.

---

## D. Feedback form

Copy these questions into a Google Form (or any form tool).

1. Your name and email (so we can follow up)
2. Years of experience: 0–1 / 2–4 / 5–9 / 10+
3. What did you try? (tick all) Resume upload · ATS check · Role resume · Cover letter · AI Job search · Skill Gap Matrix · Prepare · Get more tokens
4. How useful was the **ATS check and improved resume**? (1–5)
5. How useful was **AI Job search**? Were the jobs relevant to you? (1–5)
6. How useful was the **Skill Gap Matrix and Prepare** plan? (1–5)
7. Did anything not work, or confuse you? Where? (text)
8. What was the **most valuable** part for you? (text)
9. What is **missing** that would make you use it every week? (text)
10. Did you apply to any job you found here? Yes / No / Not yet
11. How likely are you to recommend ClassCue to a friend? (0–10)
12. Would you pay for it? No / ₹99 a month / ₹199 a month / ₹499 a month / more
13. May we contact you for a short call? Yes / No

### What "good" looks like after the pilot

| Measure | Target |
|---|---|
| Candidates who uploaded a resume | 80% or more |
| Candidates who ran an AI Job search | 60% or more |
| Average usefulness (questions 4–6) | 4 out of 5 or more |
| Recommend score (question 11) | 8 or more on average |
| Would pay something (question 12) | 30% or more |
| Server errors during the pilot | none that blocked a candidate |

### Known limits to tell candidates
- Job search reads company career sites directly; not every company is covered yet.
- AI answers can be wrong; candidates should always review documents before sending them.
- The daily AI token allowance may run out; they can ask for more from the bottom of the page.
