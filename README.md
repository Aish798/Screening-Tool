# BambooHR Candidate Matcher

A small internal tool that scans every "New" status applicant on a BambooHR
job posting, scores them against a pasted job description using Claude, and
shows you the top 10 — no need to open each profile individually.

This is a one-off / internal tool, not a BinSentry product — hence the
`vibe-` prefix on the repo name.

## How it works

```
index.html (browser)  →  Cloudflare Worker  →  BambooHR API
                                            →  Anthropic API
```

- **`index.html`** is the page you actually use day-to-day. Open it in a
  browser (via GitHub Pages, or just double-click the file locally), fill in
  the form, paste the job description, and click Scan.
- **`worker.js`** is a small proxy that does two jobs:
  1. Forwards BambooHR API requests so the browser doesn't get blocked by
     CORS restrictions (BambooHR's API isn't designed to be called directly
     from a webpage).
  2. Holds your **Anthropic API key** as a secret and calls Claude to score
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

### 2. Get an Anthropic API key
Create one at [console.anthropic.com](https://console.anthropic.com) if you
don't already have one for BinSentry's use. This one goes into the Worker,
not the browser page.

### 3. Deploy the Worker (Cloudflare)
1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages**
   → **Create** → **Worker**. A free Cloudflare account works fine for this.
2. Give it a name, e.g. `bamboohr-matcher`.
3. Open the online code editor and replace the default code with everything
   in [`worker.js`](./worker.js).
4. Go to **Settings → Variables and Secrets → Add** and create a secret:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your Anthropic API key from step 2
5. Click **Deploy**. Copy the Worker's URL — it looks like
   `https://bamboohr-matcher.<your-subdomain>.workers.dev`.

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

## Known limitations (v1)

- **Resume file text isn't parsed.** BambooHR returns uploaded resumes as
  file attachments (PDF/DOCX), not as extracted text. Scoring currently uses
  the applicant's answers to your screening questions, cover letter/notes
  text, and application source — which is often the richest signal anyway,
  but it means a strong resume with thin question answers may not surface as
  well as it should. Adding PDF/DOCX text extraction is a natural next step
  if this proves limiting.
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

## Privacy note

Your BambooHR API key is entered fresh into the browser page each session
and passed through to the Worker per-request — it is not stored in
localStorage, a database, or anywhere persistent. The Worker itself doesn't
log or store request contents beyond default Cloudflare request logging.
