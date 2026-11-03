# ShortlistPrep QA agent

Signs in like a candidate and checks, in order:

1. **Public website**: 12 pages load, titles and CSS/JS/images exist, API `/api/health`.
2. **Sign-in** and, with Playwright, the real login form, My account and **Career toolkit** (all 5 steps render, no console errors, mobile layout).
3. **Live Search with 20 resumes**: 10 IT / infrastructure / security variations (Java, data science, DevOps, security, QA, frontend, Android, data engineering, network admin, SAP) and 10 engineering branches (electronics, civil, mechanical, electrical, chemical, aerospace, biotech, instrumentation, automobile, production). For each: upload → ATS score → job search → checks the detected field, jobs found, high/medium split, how many top-20 titles fit the field, jobs from another field, apply links, time taken.

For each resume it also lists **every job** (high / medium / low) and clicks **Insight** on the best job (`INSIGHT=1` by default, `INSIGHT=0` to skip, `INSIGHT=3` for three jobs): it checks the skill matrix (weights add to 100, requirements, your status), the gaps (points, how to close, links), the study plan and the 20 practice questions. Each Insight is 2 AI calls and uses one Insight plan of the QA account. Open a resume in the report to see the details.

The result is `reports/<time>/report.html` (also `reports/latest.html`) with a **Feedback to incorporate** list at the top, plus `report.json` and screenshots.

## Run on your PC (local site)
```bash
npm run web                      # terminal 1: site :4173 and admin :4180 (needs an AI key in admin → AI keys)
node qa-agent/agent.js           # terminal 2: makes its own test account, runs all 20 resumes
LIMIT=3 node qa-agent/agent.js   # quick run
```
Browser checks need Playwright once: `cd qa-agent && npm install && npx playwright install chromium`. Skip them with `UI=off`.

## Run against the live site
Create a QA account on the website (sign up as `qa@yourdomain.com`), then give it a big plan in the admin dashboard so job-search and token limits do not stop the run (each search is deleted after it is checked).
```bash
SITE_URL=https://shortlistprep.com \   # the API address is read from the site itself; set API_URL only to override it
QA_EMAIL=qa@yourdomain.com QA_PASSWORD='...' node qa-agent/agent.js
```
On a real site the agent never creates accounts. One full run starts 20 real Live Searches, so it uses AI tokens.

## Deploy it (GitHub Actions, free, runs every morning)
1. Push the repo to GitHub (it already is). The workflow is `.github/workflows/qa-agent.yml`.
2. GitHub → repo → **Settings → Secrets and variables → Actions**: add secrets `QA_EMAIL` and `QA_PASSWORD`. Optional variables `QA_SITE_URL`, `QA_API_URL` (defaults are the live site).
3. **Actions → QA agent → Run workflow** to run now (set `limit` to 3 first). It then runs daily at 08:00 IST.
4. Open the finished run → **Artifacts → qa-report** → unzip → open `report.html`.
Exit code is 1 when anything failed, so the run shows red in GitHub.

Alternative: run it on the server VM with a cron line `0 8 * * * cd /opt/shortlistprep-app && node qa-agent/agent.js`.

## Reading the report
- **FAIL**: broken (no jobs, no apply link, search errored or timed out). **WARN**: works but quality is doubtful (wrong field, many off-field titles, few good matches). **BLOCKED**: a plan, token or missing-AI-key limit stopped the run.
- The relevance check matches job *titles* against field keywords, so treat low scores as "look at this resume", not proof.
