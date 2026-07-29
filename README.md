# BambooHR Candidate Matcher

A small internal tool that scans every "New" status applicant on a BambooHR
job posting, scores them against a pasted job description using Google Gemini, and
shows you the top 10 — no need to open each profile individually.

## How it works

```
index.html (browser)  →  Cloudflare Worker  →  BambooHR API
                                            →  Gemini API
```

- **`index.html`** is the page you actually use day-to-day. Open it in a
  browser (via GitHub Pages, or just double-click the file locally), fill in
  the form, paste the job description, and click Scan.
- **`worker.js`** is a small proxy that does two jobs:
  1. Forwards BambooHR API requests so the browser doesn't get blocked by
     CORS restrictions (BambooHR's API isn't designed to be called directly
     from a webpage).
  2. Holds your **Gemini API key** as a secret and calls Gemini to score
     candidates, so that key never has to sit in the browser.

You only have to set the Worker up once. After that, using the tool is just
the webpage.

## Setup (one-time, ~10 minutes, no terminal)

### 1. Get a BambooHR API key
In BambooHR: **Settings → API Keys → Add New Key**. This requires
Applicant Tracking System (ATS) access on your account — if you don't see
this option, you may need it granted by an admin. Copy the key somewhere
safe; you'll paste it into the tool each time you use it (it isn't saved
anywhere).

### 2. Get a free Gemini API key
Create one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) —
no credit card required. This one goes into the Worker, not the browser page.

### 3. Deploy the Worker (Cloudflare)
1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages**
   → **Create** → **Worker**. A free Cloudflare account works fine for this.
2. Give it a name, e.g. `screening-tool`.
3. Open the online code editor and replace the default code with everything
   in [`worker.js`](./worker.js).
4. Go to **Settings → Variables and Secrets → Add** and create a secret:
   - Name: `GEMINI_API_KEY`
   - Value: your Gemini API key from step 2
5. Click **Deploy**. Copy the Worker's URL — it looks like
   `https://screening-tool.<your-subdomain>.workers.dev`.

### 4. Publish the webpage (GitHub Pages)
1. In this repo's settings on GitHub: **Settings → Pages → Source → Deploy
   from a branch → main → / (root)**.
2. GitHub will give you a URL like
   `https://binsentry.github.io/vibe-bamboohr-candidate-matcher/`.
3. Open that URL any time you want to run a scan.

*(Alternative: skip GitHub Pages entirely and just open `index.html` directly
from your computer in a browser — it works the same way, just without a
shareable link.)*

## Using it

1. Open the page.
2. Fill in:
   - **BambooHR subdomain** — the part before `.bamboohr.com` in your company's URL
   - **BambooHR API key** — from step 1 above
   - **Worker URL** — from step 3 above
   - **Job ID** — found in the job posting's URL in BambooHR
3. Paste the job description.
4. Click **Scan applications**. It'll fetch every applicant currently in
   "New" status for that job, score each one, and show you the top 10 with
   a short rationale and a direct link to their BambooHR profile.

## Resume handling

Resumes attached to an application are fetched and included in scoring:

- **PDF resumes** are sent to Gemini as a native document attachment — Gemini
  reads the actual file, not just extracted text.
- **.docx resumes** are unzipped and text-extracted directly in your
  browser (no external libraries — it reads the ZIP structure and pulls text
  out of `word/document.xml`), then included as plain text.
- Anything else (older `.doc`, scanned image-only PDFs, corrupted files) is
  skipped with a note in that candidate's data, rather than silently ignored
  — so it won't tank a scan, but it also won't get credit for content Gemini
  couldn't read.

**One thing to verify on first run:** BambooHR doesn't clearly document a
dedicated endpoint for downloading ATS resume/cover-letter attachments (as
opposed to general company files), so `worker.js` tries two likely paths in
order and uses whichever responds successfully. If both fail for your
account, check the error message returned (it'll show the last status code)
and adjust the `attempts` array in `proxyBambooFile()` in `worker.js` — this
is the one part of the integration I couldn't fully confirm without a live
account to test against.

## Known limitations (v1)

- **Resume downloads add real time.** Fetching and reading a resume per
  candidate is a separate network round-trip on top of the application
  details call, so a scan of "hundreds" of applicants will take a while —
  the progress bar reflects this per-candidate as it runs.
- **Field names may need small adjustments.** BambooHR's public API docs
  render client-side, so a few field names in `index.html`
  (`buildCandidateText`) are best-effort based on documented behavior. If a
  scan comes back with blank candidate names or empty rationale text, check
  the browser console for the raw JSON from `/bamboohr/applications` and
  adjust the field mapping — it's usually a one-line fix.
- **Status filtering happens client-side** (matching on the status label
  "New") rather than relying on a single BambooHR query parameter, since
  applicant tracking accounts vary in which filters are enabled. This is
  reliable but means all applications for the job get fetched first.
- **Older `.doc` (not `.docx`) resumes aren't parsed** — that binary format
  needs a different extraction approach. If this comes up often, worth
  adding.

## Privacy note

Your BambooHR API key is entered fresh into the browser page each session
and passed through to the Worker per-request — it is not stored in
localStorage, a database, or anywhere persistent. The Worker itself doesn't
log or store request contents beyond default Cloudflare request logging.
