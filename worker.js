/**
 * BambooHR Candidate Matcher — Cloudflare Worker
 * -----------------------------------------------
 * Purpose:
 *   1. Proxies requests to the BambooHR Applicant Tracking API so the
 *      browser-based tool (index.html) can call it without hitting CORS
 *      restrictions. Your BambooHR API key travels through this worker
 *      but is never stored by it.
 *   2. Calls the Google Gemini API to score/rank candidates against a
 *      pasted job description. The Gemini API key IS stored here, as a
 *      Worker secret (free tier available, no billing required), so it
 *      never has to live in the browser.
 *
 * Deploy:
 *   1. Paste this whole file as your Worker's code.
 *   2. Get a free Gemini API key at https://aistudio.google.com/apikey
 *   3. Go to Settings -> Variables and Secrets -> add a secret:
 *        Name: GEMINI_API_KEY
 *        Value: <your key from aistudio.google.com>
 *   4. Deploy. Copy the worker's URL and paste it into index.html.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Bamboo-Domain, X-Bamboo-Key",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/bamboohr/applications") {
        return await proxyBambooApplications(request, url);
      }
      // /bamboohr/files/:applicationId/:fileId  (must be checked before the
      // more general /bamboohr/applications/ prefix match below)
      const fileMatch = url.pathname.match(/^\/bamboohr\/files\/([^/]+)\/([^/]+)$/);
      if (fileMatch) {
        return await proxyBambooFile(request, fileMatch[1], fileMatch[2]);
      }
      if (url.pathname.startsWith("/bamboohr/applications/")) {
        const applicationId = url.pathname.split("/").pop();
        return await proxyBambooApplicationDetail(request, applicationId);
      }
      if (url.pathname === "/bamboohr/jobs") {
        return await proxyBambooJobs(request);
      }
      if (url.pathname === "/match" && request.method === "POST") {
        return await matchCandidates(request, env);
      }

      return jsonResponse({ error: "Unknown route" }, 404);
    } catch (err) {
      return jsonResponse({ error: String(err && err.message ? err.message : err) }, 500);
    }
  },
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function bambooAuthHeaders(request) {
  const domain = request.headers.get("X-Bamboo-Domain");
  const key = request.headers.get("X-Bamboo-Key");
  if (!domain || !key) {
    throw new Error("Missing X-Bamboo-Domain or X-Bamboo-Key header");
  }
  const basic = btoa(`${key}:x`);
  return { domain, headers: { Authorization: `Basic ${basic}`, Accept: "application/json" } };
}

async function proxyBambooJobs(request) {
  const { domain, headers } = bambooAuthHeaders(request);
  const upstream = `https://${domain}.bamboohr.com/api/v1/applicant_tracking/jobs`;
  const res = await fetch(upstream, { headers });
  const body = await res.text();
  return new Response(body, { status: res.status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

async function proxyBambooApplications(request, url) {
  const { domain, headers } = bambooAuthHeaders(request);
  const params = url.searchParams;
  const upstream = new URL(`https://${domain}.bamboohr.com/api/v1/applicant_tracking/applications`);
  // Pass through whatever filters the client sent (jobId, page, applicationStatus, etc.)
  for (const [k, v] of params.entries()) {
    if (k !== "domain") upstream.searchParams.set(k, v);
  }
  const res = await fetch(upstream.toString(), { headers });
  const body = await res.text();
  return new Response(body, { status: res.status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

async function proxyBambooApplicationDetail(request, applicationId) {
  const { domain, headers } = bambooAuthHeaders(request);
  const upstream = `https://${domain}.bamboohr.com/api/v1/applicant_tracking/applications/${applicationId}`;
  const res = await fetch(upstream, { headers });
  const body = await res.text();
  return new Response(body, { status: res.status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

/**
 * Downloads a resume/cover-letter file attached to an application.
 *
 * BambooHR's public docs don't clearly document a dedicated ATS attachment
 * download route, so this tries the two most likely candidates in order:
 *   1. /v1/applicant_tracking/applications/{applicationId}/files/{fileId}
 *      (mirrors the pattern used for employee files)
 *   2. /v1/files/{fileId}
 *      (the general company file-repository download route)
 * If your account's file lives somewhere else, this is the place to adjust —
 * add another attempt to the `attempts` array below.
 */
async function proxyBambooFile(request, applicationId, fileId) {
  const { domain, headers } = bambooAuthHeaders(request);
  const attempts = [
    `https://${domain}.bamboohr.com/api/v1/applicant_tracking/applications/${applicationId}/files/${fileId}`,
    `https://${domain}.bamboohr.com/api/v1/files/${fileId}`,
  ];

  let lastStatus = 404;
  for (const upstream of attempts) {
    const res = await fetch(upstream, { headers });
    if (res.ok) {
      const contentType = res.headers.get("Content-Type") || "application/octet-stream";
      const contentDisposition = res.headers.get("Content-Disposition") || "";
      const buf = await res.arrayBuffer();
      return new Response(buf, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "X-Original-Content-Disposition": contentDisposition,
          ...CORS_HEADERS,
        },
      });
    }
    lastStatus = res.status;
  }
  return jsonResponse({ error: `Could not download file ${fileId} for application ${applicationId} (last status ${lastStatus}). BambooHR's attachment route may differ for your account — see worker.js proxyBambooFile().` }, 502);
}

/**
 * Body: { jobDescription: string, candidates: [{ id, name, text, resumePdfBase64? }] }
 * Returns: { results: [{ id, score, rationale }] }
 *
 * Calls Google's Gemini API (free tier available, no billing required) to
 * score candidates. Candidates carrying a `resumePdfBase64` get that PDF
 * attached as inline document data so Gemini reads the actual resume, not
 * just question answers. Because attached PDFs make each request heavier,
 * batches with attachments are kept smaller than text-only batches.
 */
async function matchCandidates(request, env) {
  if (!env.GEMINI_API_KEY) {
    return jsonResponse({ error: "GEMINI_API_KEY secret is not configured on this Worker." }, 500);
  }

  const { jobDescription, candidates } = await request.json();
  if (!jobDescription || !Array.isArray(candidates)) {
    return jsonResponse({ error: "Expected { jobDescription, candidates[] }" }, 400);
  }

  const TEXT_ONLY_BATCH_SIZE = 10;
  const WITH_PDF_BATCH_SIZE = 3;

  const batches = [];
  let i = 0;
  while (i < candidates.length) {
    const hasPdf = !!candidates[i].resumePdfBase64;
    const size = hasPdf ? WITH_PDF_BATCH_SIZE : TEXT_ONLY_BATCH_SIZE;
    const batch = [];
    while (batch.length < size && i < candidates.length && !!candidates[i].resumePdfBase64 === hasPdf) {
      batch.push(candidates[i]);
      i++;
    }
    batches.push(batch);
  }

  const allResults = [];
  for (const batch of batches) {
    const parts = buildGeminiParts(jobDescription, batch);
    const model = "const model = "gemini-3.6-flash";";
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      return jsonResponse({ error: `Gemini API error: ${errText}` }, 502);
    }

    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "")
      .join("\n");

    let parsed;
    try {
      const cleaned = text.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      continue; // skip a malformed batch rather than failing the whole scan
    }

    if (Array.isArray(parsed)) allResults.push(...parsed);
  }

  allResults.sort((a, b) => (b.score || 0) - (a.score || 0));
  return jsonResponse({ results: allResults.slice(0, 10), totalScored: allResults.length });
}

function buildGeminiParts(jobDescription, batch) {
  const parts = [];

  parts.push({
    text: `You are screening job applicants against a job description. Score each candidate 0-100 on fit, based only on the information provided (do not invent facts not present in their application or resume). Weigh required skills/experience most heavily, then relevant background, then nice-to-haves.

JOB DESCRIPTION:
${jobDescription}

CANDIDATES:`,
  });

  for (const c of batch) {
    parts.push({
      text: `\n--- CANDIDATE ${c.id} (${c.name}) ---\n${c.text || "(no screening-question or note text available)"}${c.resumePdfBase64 ? "\nTheir resume PDF is attached below." : ""}`,
    });
    if (c.resumePdfBase64) {
      parts.push({
        inline_data: { mime_type: "application/pdf", data: c.resumePdfBase64 },
      });
    }
  }

  parts.push({
    text: `\nRespond with ONLY a JSON array, no other text, no markdown fences. Each element:
{"id": "<candidate id exactly as given>", "score": <integer 0-100>, "rationale": "<1-2 sentence explanation citing specific matches or gaps>"}`,
  });

  return parts;
}
