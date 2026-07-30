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
      const fileMatch = url.pathname.match(/^\/bamboohr\/files\/([^/]+)\/([^/]+)$/);
      if (fileMatch) {
        return await proxyBambooFile(request, fileMatch[1], fileMatch[2]);
      }
      if (url.pathname === "/bamboohr/statuses") {
        return await proxyBambooStatuses(request);
      }
      const statusUpdateMatch = url.pathname.match(/^\/bamboohr\/applications\/([^/]+)\/status$/);
      if (statusUpdateMatch && request.method === "POST") {
        return await proxyUpdateStatus(request, statusUpdateMatch[1]);
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
 * Fetches the list of valid applicant statuses (needed to know the ID for
 * "Shortlist" before updating an application). BambooHR's docs reference a
 * "Get Applicant Statuses" endpoint without a fully confirmed URL, so this
 * tries the two most likely paths in order.
 */
async function proxyBambooStatuses(request) {
  const { domain, headers } = bambooAuthHeaders(request);
  const attempts = [
    `https://${domain}.bamboohr.com/api/v1/applicant_tracking/applications/statuses`,
    `https://${domain}.bamboohr.com/api/v1/applicant_tracking/statuses`,
  ];
  let lastStatus = 404;
  let lastBody = "";
  for (const upstream of attempts) {
    const res = await fetch(upstream, { headers });
    if (res.ok) {
      const body = await res.text();
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
    }
    lastStatus = res.status;
    lastBody = await res.text();
  }
  return jsonResponse({ error: `Could not fetch applicant statuses (last status ${lastStatus}): ${lastBody}` }, 502);
}

/**
 * Updates an application's status (e.g. to "Shortlist"). Forwards whatever
 * JSON body the browser sends straight through to BambooHR — the exact
 * expected body shape isn't fully confirmed from public docs, so if this
 * errors, the response text below will show BambooHR's own complaint about
 * what's wrong with the request, which is the fastest way to correct it.
 */
async function proxyUpdateStatus(request, applicationId) {
  const { domain, headers } = bambooAuthHeaders(request);
  const requestBody = await request.text();
  const upstream = `https://${domain}.bamboohr.com/api/v1/applicant_tracking/applications/${applicationId}/status`;
  const res = await fetch(upstream, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: requestBody,
  });
  const responseBody = await res.text();
  return new Response(responseBody, {
    status: res.status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

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
  return jsonResponse({ error: `Could not download file ${fileId} for application ${applicationId} (last status ${lastStatus}). BambooHR's attachment route may differ for your account — see proxyBambooFile().` }, 502);
}

/**
 * Scores ONE batch of candidates per call. The browser is responsible for
 * splitting candidates into batches and calling this endpoint once per
 * batch (with pacing between calls) — see index.html's scoreCandidates().
 *
 * This is deliberately NOT a single request that loops through every batch
 * internally: Cloudflare's free plan caps a single Worker invocation at 50
 * outgoing subrequests, and a large scan (hundreds of candidates, dozens of
 * batches, each possibly retried) can blow past that within one request,
 * which crashes the whole invocation with an opaque 502. Doing one batch
 * per HTTP call keeps each individual invocation's subrequest count low
 * (1 call, plus a few retries at most) regardless of how many total
 * candidates a scan covers.
 */
async function matchCandidates(request, env) {
  if (!env.GEMINI_API_KEY) {
    return jsonResponse({ error: "GEMINI_API_KEY secret is not configured on this Worker." }, 500);
  }

  const { jobDescription, candidates } = await request.json();
  if (!jobDescription || !Array.isArray(candidates)) {
    return jsonResponse({ error: "Expected { jobDescription, candidates[] } (one batch)" }, 400);
  }

  const parts = buildGeminiParts(jobDescription, candidates);
  const model = "gemini-3.5-flash-lite";
  const data = await callGeminiWithRetry(model, parts, env.GEMINI_API_KEY);
  if (data.__error) {
    return jsonResponse({ error: data.__error }, 502);
  }

  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("\n");

  let parsed = [];
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) parsed = [];
  } catch (e) {
    parsed = [];
  }

  return jsonResponse({ results: parsed });
}

/**
 * Calls Gemini with retries for transient errors (503 "high demand" /
 * overloaded, and 429 rate limits). When Google tells us how long to wait
 * (via the RetryInfo detail or the "Please retry in Xs" message text), we
 * honor that instead of guessing — free-tier rate-limit waits are often
 * 20-40+ seconds, longer than a naive short backoff would cover.
 */
async function callGeminiWithRetry(model, parts, apiKey, maxAttempts = 5) {
  let lastErrorText = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );

    if (res.ok) {
      return await res.json();
    }

    lastErrorText = await res.text();
    const isRetryable = res.status === 503 || res.status === 429;
    if (!isRetryable || attempt === maxAttempts) {
      return { __error: `Gemini API error (status ${res.status}): ${lastErrorText}` };
    }

    const suggestedDelayMs = parseRetryDelayMs(lastErrorText);
    const backoffMs = suggestedDelayMs ?? 1000 * Math.pow(2, attempt - 1);
    // Add a small buffer on top of Google's suggested delay to be safe
    const delayMs = suggestedDelayMs ? backoffMs + 2000 : backoffMs;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { __error: `Gemini API error after ${maxAttempts} attempts: ${lastErrorText}` };
}

/**
 * Gemini's 429 responses often include how long to wait, either as a
 * structured RetryInfo.retryDelay (e.g. "31s") or in the message text
 * ("Please retry in 31.34s"). This pulls that number out in milliseconds
 * so we can honor it instead of guessing with a fixed backoff.
 */
function parseRetryDelayMs(errorText) {
  try {
    const parsed = JSON.parse(errorText);
    const retryInfo = (parsed?.error?.details || []).find(
      (d) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
    );
    if (retryInfo?.retryDelay) {
      const seconds = parseFloat(String(retryInfo.retryDelay).replace("s", ""));
      if (!isNaN(seconds)) return Math.ceil(seconds * 1000);
    }
  } catch (e) {
    // fall through to regex attempt below
  }
  const match = errorText.match(/retry in ([\d.]+)s/i);
  if (match) return Math.ceil(parseFloat(match[1]) * 1000);
  return null;
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
