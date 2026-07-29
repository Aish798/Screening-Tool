/**
 * BambooHR Candidate Matcher — Cloudflare Worker
 * -----------------------------------------------
 * Purpose:
 *   1. Proxies requests to the BambooHR Applicant Tracking API so the
 *      browser-based tool (index.html) can call it without hitting CORS
 *      restrictions. Your BambooHR API key travels through this worker
 *      but is never stored by it.
 *   2. Calls the Anthropic API (Claude) to score/rank candidates against
 *      a pasted job description. The Anthropic API key IS stored here,
 *      as a Worker secret, so it never has to live in the browser.
 *
 * Deploy (no terminal needed):
 *   1. Go to https://dash.cloudflare.com -> Workers & Pages -> Create -> Worker
 *   2. Paste this whole file into the online code editor, replacing the default.
 *   3. Go to Settings -> Variables and Secrets -> add a secret:
 *        Name: ANTHROPIC_API_KEY
 *        Value: <your Anthropic API key from console.anthropic.com>
 *   4. Deploy. Copy the worker's URL (looks like
 *        https://bamboohr-matcher.<your-subdomain>.workers.dev
 *      and paste it into the "Worker URL" field in index.html.
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
 * Body: { jobDescription: string, candidates: [{ id, name, text }] }
 * Returns: { results: [{ id, score, rationale }] }
 * Batches candidates (to keep prompts a reasonable size) and asks Claude
 * for strict JSON output, then merges + sorts across batches.
 */
async function matchCandidates(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY secret is not configured on this Worker." }, 500);
  }

  const { jobDescription, candidates } = await request.json();
  if (!jobDescription || !Array.isArray(candidates)) {
    return jsonResponse({ error: "Expected { jobDescription, candidates[] }" }, 400);
  }

  const BATCH_SIZE = 12;
  const batches = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batches.push(candidates.slice(i, i + BATCH_SIZE));
  }

  const allResults = [];
  for (const batch of batches) {
    const prompt = buildPrompt(jobDescription, batch);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return jsonResponse({ error: `Anthropic API error: ${errText}` }, 502);
    }

    const data = await res.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
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

function buildPrompt(jobDescription, batch) {
  const candidateBlocks = batch
    .map(
      (c) => `--- CANDIDATE ${c.id} ---\nName: ${c.name}\nApplication content:\n${c.text || "(no additional text available)"}`
    )
    .join("\n\n");

  return `You are screening job applicants against a job description. Score each candidate 0-100 on fit, based only on the information provided (do not invent facts not present in their application). Weigh required skills/experience most heavily, then relevant background, then nice-to-haves.

JOB DESCRIPTION:
${jobDescription}

CANDIDATES:
${candidateBlocks}

Respond with ONLY a JSON array, no other text, no markdown fences. Each element:
{"id": "<candidate id exactly as given>", "score": <integer 0-100>, "rationale": "<1-2 sentence explanation citing specific matches or gaps>"}`;
}
