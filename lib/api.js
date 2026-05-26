/**
 * lib/api.js
 * HTTP API server for Greg — accepts ad submissions from Digi or other
 * trusted sources, marks ads posted from external systems.
 *
 * Mounted alongside the Telegraf polling bot in wizard.js.
 *
 * Routes:
 *   GET  /api/health            — Railway health check (public)
 *   POST /api/ad/intake         — Bearer auth, ingest a complete ad payload
 *   POST /api/ad/posted         — Bearer auth, mark a posted_ad live
 *
 * Auth: Bearer token via Authorization header. Token from GREG_API_SECRET env.
 */

const http           = require("http");
const sessions       = require("./sessions");
const bulkTemplates  = require("./bulkTemplates");
const pagesRegistry  = require("./pages");

const GREG_API_SECRET = process.env.GREG_API_SECRET || process.env.DIGI_API_SECRET;
const PORT             = parseInt(process.env.GREG_API_PORT || process.env.PORT || "3001", 10);

if (!GREG_API_SECRET) {
  console.warn("[api] GREG_API_SECRET not set — HTTP API will reject all auth'd requests");
}

// ── Payload normalization ────────────────────────────────────────────────
// Digi's new payload uses `coverStrategy` + typed `sharedSlides: Slide[]`.
// We accept both new and legacy shapes (string[], `format` field) and
// normalize them to a single canonical structure before validation.
//
// Canonical shape (post-normalize):
//   format         : 'per-page' | 'standard' | 'collab' | 'hybrid'   (derived)
//   sharedSlides   : Array<{ type: 'image' | 'video', url, label? }>
//   videos[*].mediaType : 'image' | 'video'                          (filled in)

function inferType(url) {
  return /\.(mp4|mov|webm)(\?|$)/i.test(String(url || "")) ? "video" : "image";
}

function normalizeSlide(s) {
  if (!s) return null;
  if (typeof s === "string") return { type: inferType(s), url: s };
  if (typeof s === "object" && s.url) {
    // Reject text slides at this layer — Digi must pre-render them to image URLs
    // using the cover template before submitting. Greg has no rendering engine.
    if (s.type === "text") return null;
    return {
      type:  s.type === "video" || s.type === "image" ? s.type : inferType(s.url),
      url:   s.url,
      label: s.label,
    };
  }
  return null;
}

function normalizeSlides(slides) {
  if (!Array.isArray(slides)) return [];
  return slides.map(normalizeSlide).filter(Boolean);
}

/**
 * Derive `format` from the new `coverStrategy` field. Falls back to the
 * legacy `format` field for backward compat with older clients.
 */
function deriveFormat(payload) {
  const cs = payload.coverStrategy;
  if (cs) {
    if (cs === "collab")   return "collab";
    if (cs === "shared")   return "standard";
    if (cs === "per-page") {
      const hasShared = Array.isArray(payload.sharedSlides) && payload.sharedSlides.length > 0;
      return hasShared ? "hybrid" : "per-page";
    }
  }
  return payload.format || "standard";
}

/**
 * Normalize the raw intake payload into a consistent shape that downstream
 * code (validateIntake, poster.js) can rely on. Mutates a shallow copy.
 */
function normalizePayload(input) {
  if (!input || typeof input !== "object") return input;
  const out = { ...input };

  // 1. Normalize sharedSlides → typed Slide[]
  out.sharedSlides = normalizeSlides(input.sharedSlides);

  // 2. Prepend sharedCover (new field for coverStrategy='shared') if provided
  if (input.sharedCover) {
    const cover = normalizeSlide(input.sharedCover);
    if (cover) out.sharedSlides = [cover, ...out.sharedSlides];
  }

  // 3. Legacy fallback: sharedCreativeUrl was the old single-slide shape
  if (input.sharedCreativeUrl && out.sharedSlides.length === 0) {
    out.sharedSlides = [{ type: inferType(input.sharedCreativeUrl), url: input.sharedCreativeUrl }];
  }

  // 4. Fill in videos[*].mediaType if missing (collab format)
  if (Array.isArray(out.videos)) {
    out.videos = out.videos.map((v) => ({
      ...v,
      mediaType: v?.mediaType === "video" || v?.mediaType === "image"
        ? v.mediaType
        : inferType(v?.mediaUrl),
    }));
  }

  // 5. Derive format last (uses normalized sharedSlides)
  out.format = deriveFormat(out);

  // 6. Auto-downgrade hybrid → per-page if no shared slides. This catches
  //    legacy callers that explicitly send format='hybrid' with an empty
  //    sharedSlides[] (the new model says hybrid is emergent — only when
  //    you have BOTH per-page covers AND shared slides).
  if (out.format === "hybrid" && (!Array.isArray(out.sharedSlides) || out.sharedSlides.length === 0)) {
    out.format = "per-page";
  }

  return out;
}

/**
 * Helper: read a JSON body from a Node http request.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!body) return resolve(null);
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error(`Invalid JSON: ${e.message}`)); }
    });
    req.on("error", reject);
  });
}

/**
 * Helper: write a JSON response.
 */
function send(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * Bearer auth check — returns true if authorized.
 */
function authorized(req) {
  if (!GREG_API_SECRET) return false;
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return false;
  return auth.slice(7) === GREG_API_SECRET;
}

/**
 * Validate a normalized /api/ad/intake payload. Caller must run
 * normalizePayload() first. Returns { valid, errors[] }.
 */
function validateIntake(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") {
    return { valid: false, errors: ["payload must be an object"] };
  }

  const { campaign, adInfo, pages, format, sharedSlides, videos } = payload;

  if (!campaign?.client) errors.push("campaign.client is required");
  if (!campaign?.adType) errors.push("campaign.adType is required");
  if (campaign?.basePrice == null) errors.push("campaign.basePrice is required");

  if (!adInfo?.time) errors.push("adInfo.time is required");
  if (!adInfo?.postType) errors.push("adInfo.postType is required");
  if (!adInfo?.duration) errors.push("adInfo.duration is required");

  // format is derived by normalizePayload from coverStrategy or the legacy
  // format field. Default to 'standard' for empty payloads.
  const fmt = format || "standard";
  if (!["per-page", "standard", "collab", "hybrid"].includes(fmt)) {
    errors.push(`format must be one of: per-page, standard, collab, hybrid (got '${fmt}')`);
  }

  if (fmt === "collab") {
    // Collab uses videos[] with nested groups[]. pages[] is derived.
    if (!Array.isArray(videos) || videos.length === 0) {
      errors.push("videos must be a non-empty array for format=collab");
    } else {
      videos.forEach((v, i) => {
        if (!v.mediaUrl) errors.push(`videos[${i}].mediaUrl is required`);
        if (!Array.isArray(v.groups) || v.groups.length === 0) {
          errors.push(`videos[${i}].groups must be a non-empty array`);
        } else {
          v.groups.forEach((g, j) => {
            if (!g.host) errors.push(`videos[${i}].groups[${j}].host is required`);
            if (!Array.isArray(g.invites) || g.invites.length === 0) {
              errors.push(`videos[${i}].groups[${j}].invites must be a non-empty array`);
            }
          });
        }
      });
    }
  } else if (fmt === "standard") {
    if (!Array.isArray(sharedSlides) || sharedSlides.length === 0) {
      errors.push("sharedSlides[]/sharedCover is required for coverStrategy=shared (or legacy format=standard)");
    }
    if (!Array.isArray(pages) || pages.length === 0) {
      errors.push("pages must be a non-empty array");
    } else {
      pages.forEach((p, i) => {
        if (!p.handle) errors.push(`pages[${i}].handle is required`);
      });
    }
  } else if (fmt === "hybrid") {
    // Hybrid = per-page covers + shared slides. Derived when coverStrategy='per-page'
    // and sharedSlides is non-empty.
    if (!Array.isArray(pages) || pages.length === 0) {
      errors.push("pages must be a non-empty array for hybrid");
    } else {
      pages.forEach((p, i) => {
        if (!p.handle)   errors.push(`pages[${i}].handle is required`);
        if (!p.coverUrl) errors.push(`pages[${i}].coverUrl is required for hybrid`);
      });
    }
    if (!Array.isArray(sharedSlides) || sharedSlides.length === 0) {
      errors.push("sharedSlides[] is required for hybrid (otherwise use coverStrategy=per-page without shared slides)");
    }
  } else {
    // per-page (no shared slides)
    if (!Array.isArray(pages) || pages.length === 0) {
      errors.push("pages must be a non-empty array");
    } else {
      pages.forEach((p, i) => {
        if (!p.handle) errors.push(`pages[${i}].handle is required`);
        // Per-page requires either creativeUrl (legacy) or coverUrl (new)
        if (!p.creativeUrl && !p.coverUrl) {
          errors.push(`pages[${i}] requires creativeUrl or coverUrl for per-page`);
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Build the API handler factory. Takes deps (bot, intakeProcessor) so the
 * HTTP server can call back into the wizard's posting pipeline.
 *
 * intakeProcessor: async fn({ session, payload }) — handles auto-approve
 *                   flow including cancel window + final posting.
 *
 * @param {object} deps
 * @param {object} deps.bot                 Telegraf instance for sending notifications
 * @param {function} deps.handleIntake     Called after session is persisted, runs auto-approve flow
 * @returns {http.Server}
 */
function createServer({ bot, handleIntake }) {
  const server = http.createServer(async (req, res) => {
    const url = req.url || "";
    const method = req.method || "GET";

    // ── Public health check ─────────────────────────────────────────────
    if (method === "GET" && url === "/api/health") {
      return send(res, 200, { ok: true, service: "greg", ts: new Date().toISOString() });
    }

    // ── Auth required for everything below ──────────────────────────────
    if (!authorized(req)) {
      return send(res, 401, { error: "unauthorized" });
    }

    // ── GET /api/bulks ──────────────────────────────────────────────────
    // Returns all bulk templates with current per-page slot state. Each
    // template entry includes `pages[]` enriched with `next` (the next
    // slot string the page would consume) so Digi's BulkSelector can show
    // "@goal: 13/15 → next 14/15" inline.
    if (method === "GET" && (url === "/api/bulks" || url.startsWith("/api/bulks?"))) {
      const all = bulkTemplates.list();
      const enriched = all.map((b) => bulkTemplates.pageStatusFor(b.id));
      return send(res, 200, { bulks: enriched });
    }

    // ── POST /api/bulks ─────────────────────────────────────────────────
    // Create a new bulk template. Body is the template object (camelCase).
    // `id` is optional — slugified from `name` if omitted.
    if (method === "POST" && url === "/api/bulks") {
      let body;
      try { body = await readBody(req); }
      catch (e) { return send(res, 400, { error: e.message }); }

      const result = bulkTemplates.create(body || {});
      if (result.error) return send(res, 400, { error: result.error });
      return send(res, 201, { bulk: result.bulk, status: bulkTemplates.pageStatusFor(result.bulk.id) });
    }

    // ── GET /api/bulks/:id/progress ─────────────────────────────────────
    // Dashboard rollup: completion %, $ committed/spent/remaining,
    // per-page progress. Read-only.
    {
      const m = url.match(/^\/api\/bulks\/([^/]+)\/progress$/);
      if (method === "GET" && m) {
        const id = decodeURIComponent(m[1]);
        const p  = bulkTemplates.progress(id);
        if (!p) return send(res, 404, { error: `bulk template not found: ${id}` });
        return send(res, 200, p);
      }
    }

    // ── GET / PATCH / DELETE /api/bulks/:id ─────────────────────────────
    {
      const m = url.match(/^\/api\/bulks\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);

        if (method === "GET") {
          const status = bulkTemplates.pageStatusFor(id);
          if (!status) return send(res, 404, { error: `bulk template not found: ${id}` });
          return send(res, 200, status);
        }

        if (method === "PATCH") {
          let body;
          try { body = await readBody(req); }
          catch (e) { return send(res, 400, { error: e.message }); }
          const result = bulkTemplates.update(id, body || {});
          if (result.error) {
            const status = result.error.includes("not found") ? 404 : 400;
            return send(res, status, { error: result.error });
          }
          return send(res, 200, { bulk: result.bulk, status: bulkTemplates.pageStatusFor(id) });
        }

        if (method === "DELETE") {
          const result = bulkTemplates.remove(id);
          if (result.error) {
            const status = result.error.includes("not found") ? 404 : 400;
            return send(res, status, { error: result.error });
          }
          return send(res, 200, { deleted: true, bulk: result.bulk });
        }
      }
    }

    // ── GET /api/pages ──────────────────────────────────────────────────
    // Returns the full pages registry — handle / sheet_id / chat_id /
    // auto_forward / display_name / notes. Drives Digi's /admin/pages
    // table view. Async to ensure we get freshest data (the in-process
    // cache also refreshes every 60s, but the UI deserves a fresh read
    // on load).
    if (method === "GET" && (url === "/api/pages" || url.startsWith("/api/pages?"))) {
      const all = await pagesRegistry.listAll();
      return send(res, 200, { pages: all });
    }

    // ── POST /api/pages ─────────────────────────────────────────────────
    // Create or upsert a page. Body shape:
    //   { handle, sheet_id?, chat_id?, auto_forward?, display_name?, notes? }
    // handle is required and lowercased + stripped of '@'. Other fields
    // are optional — existing values are preserved if omitted.
    if (method === "POST" && url === "/api/pages") {
      let body;
      try { body = await readBody(req); }
      catch (e) { return send(res, 400, { error: e.message }); }
      if (!body?.handle) return send(res, 400, { error: "handle is required" });
      const result = await pagesRegistry.upsertPage(body);
      if (!result.ok) return send(res, 400, { error: result.error });
      return send(res, 201, { page: result.row });
    }

    // ── GET /api/chats/search?q=<query> ─────────────────────────────────
    // Filters the @sales_bolismedia user account's dialog list by name
    // substring. Drives Digi's /admin/page-registry "Find chat by handle"
    // lookup — Connor types a page handle, we surface candidate IG Ads
    // chats so he can click one instead of hunting for the numeric ID.
    //
    // The user account is a member of every page's chat by design (that's
    // what GREG_SALES_CHAT and the recap pipeline rely on), so substring
    // matching against the chat title is enough.
    if (method === "GET" && url.startsWith("/api/chats/search")) {
      const q = new URL(url, "http://x").searchParams.get("q") || "";
      try {
        // Lazy-require so the API module doesn't crash if GramJS env
        // vars aren't set in some deploys (Digi UI just shows no matches).
        const userClient = require("../userClient");
        const matches = await userClient.searchChats(q, { limit: 20 });
        return send(res, 200, { matches });
      } catch (e) {
        return send(res, 503, {
          matches: [],
          error: `chat search unavailable: ${e.message}`,
        });
      }
    }

    // ── GET / PATCH / DELETE /api/pages/:handle ─────────────────────────
    {
      const m = url.match(/^\/api\/pages\/([^/?]+)/);
      if (m) {
        const handle = decodeURIComponent(m[1]).toLowerCase().replace(/^@/, "");

        if (method === "GET") {
          const row = pagesRegistry.getPage(handle);
          if (!row) return send(res, 404, { error: `page not found: ${handle}` });
          return send(res, 200, { page: row });
        }

        if (method === "PATCH") {
          let body;
          try { body = await readBody(req); }
          catch (e) { return send(res, 400, { error: e.message }); }
          // Use handle from the URL — body's handle (if any) is ignored
          // to prevent renames-via-PATCH (could break refs elsewhere).
          const result = await pagesRegistry.upsertPage({ ...(body || {}), handle });
          if (!result.ok) return send(res, 400, { error: result.error });
          return send(res, 200, { page: result.row });
        }

        if (method === "DELETE") {
          const existing = pagesRegistry.getPage(handle);
          if (!existing) return send(res, 404, { error: `page not found: ${handle}` });
          const result = await pagesRegistry.deletePage(handle);
          if (!result.ok) return send(res, 400, { error: result.error });
          return send(res, 200, { deleted: true, handle });
        }
      }
    }

    // ── POST /api/ad/intake ─────────────────────────────────────────────
    if (method === "POST" && url === "/api/ad/intake") {
      let rawBody;
      try {
        rawBody = await readBody(req);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }

      // Normalize the payload (typed slides, derived format) BEFORE validation
      // so downstream code (poster.js) only ever sees the canonical shape.
      const body = normalizePayload(rawBody);

      // ── Bulk-template hydration ────────────────────────────────────────
      // If the caller passes `bulkId`, we look up `config/bulks.json`
      // and fill in any missing campaign/adInfo/pages fields, plus plan
      // a per-page slot advance ("13/15" → "14/15"). The plan is stashed
      // in the payload as `_bulkPlan`; poster.js commits it back to disk
      // (and mirrors to Supabase) only after a successful post — so a
      // cancelled intake doesn't burn slots.
      let bulkPlan = null;
      if (rawBody.bulkId) {
        const bulk = bulkTemplates.get(rawBody.bulkId);
        if (!bulk) {
          return send(res, 400, { error: `bulk template not found: ${rawBody.bulkId}` });
        }

        // Hydrate campaign defaults
        body.campaign = body.campaign || {};
        body.campaign.adType = body.campaign.adType || bulk.adType;
        const baseClient = body.campaign.client || bulk.client;
        const refLine = bulk.refPrefix ? `${bulk.refPrefix} ${(bulk.lastRefNum || 0) + 1}` : null;
        body.campaign.client = refLine ? `${baseClient} ${refLine}`.trim() : baseClient;

        // Hydrate adInfo defaults
        body.adInfo = body.adInfo || {};
        body.adInfo.postType = body.adInfo.postType || bulk.postType;
        body.adInfo.duration = body.adInfo.duration || bulk.duration;
        if (body.adInfo.nif === undefined) body.adInfo.nif = bulk.nif;
        if (!Array.isArray(body.adInfo.seniors) || body.adInfo.seniors.length === 0) {
          body.adInfo.seniors = [...(bulk.seniors || [])];
        }

        // If pages weren't provided, default to the template's full roster
        if (!Array.isArray(body.pages) || body.pages.length === 0) {
          body.pages = (bulk.pages || []).map((handle) => {
            const entry = bulk.perPagePrices?.[handle] || {};
            return {
              handle,
              price: entry.price != null ? parseFloat(entry.price) : undefined,
            };
          });
        } else {
          // Pages provided: still backfill per-page prices from template if missing
          for (const page of body.pages) {
            const handle = String(page.handle).replace(/^@/, "").toLowerCase();
            const entry = bulk.perPagePrices?.[handle] || bulk.perPagePrices?.[page.handle] || {};
            if (page.price == null && entry.price != null) {
              page.price = parseFloat(entry.price);
            }
          }
        }

        // Plan slot advance for the pages we're shipping (does NOT write to disk)
        const handles = body.pages.map((p) => p.handle);
        bulkPlan = bulkTemplates.planAdvance(rawBody.bulkId, handles);

        // Apply planned slots to pages[].bulkNum (only if caller didn't override)
        if (bulkPlan) {
          for (const page of body.pages) {
            const handle = String(page.handle).replace(/^@/, "").toLowerCase();
            if (!page.bulkNum && bulkPlan.perHandle[handle]) {
              page.bulkNum = bulkPlan.perHandle[handle].slot;
            }
          }
        }

        // basePrice: sum per-page prices if not provided
        if (body.campaign.basePrice == null) {
          const sum = body.pages.reduce((acc, p) => {
            const n = parseFloat(p.price || 0);
            return acc + (Number.isFinite(n) ? n : 0);
          }, 0);
          body.campaign.basePrice = sum;
        }

        // Stash for executeIntake to commit on success
        body.bulkId    = rawBody.bulkId;
        body._bulkPlan = bulkPlan;
      }

      const v = validateIntake(body);
      if (!v.valid) {
        return send(res, 400, { error: "validation failed", details: v.errors });
      }

      // Use the configured admin (Connor) as the approval target if no user_id given
      const userId = body.userId || parseInt(process.env.WIZARD_ADMIN_USER_ID || "0", 10);
      if (!userId) {
        return send(res, 500, { error: "WIZARD_ADMIN_USER_ID not configured" });
      }

      // Create session in Supabase (stores normalized payload)
      const session = await sessions.createSession({
        userId,
        source: body.trustedSource || "api",
        step: "awaiting_approval",
        payload: body,
        trusted: !!body.trustedSource,
      });

      if (!session) {
        return send(res, 500, { error: "failed to create session" });
      }

      // Persist creatives indexed for posted-ad lookup later (caption matching).
      // For all formats we store: page_handle → media_url + headline.
      // sharedSlides at this point is always Slide[] = { type, url, label? }
      const fmt = body.format;

      if (fmt === "collab") {
        // For each video, every page in every group references that video
        for (const video of (body.videos || [])) {
          for (const group of (video.groups || [])) {
            const allHandles = [group.host, ...(group.invites || [])].filter(Boolean);
            for (const handle of allHandles) {
              await sessions.addCreative(session.id, {
                pageHandle: handle.replace(/^@/, "").toLowerCase(),
                mediaUrl:   video.mediaUrl,
                mediaType:  video.mediaType,
                headline:   null,
                metadata:   { format: "collab", host: group.host, invites: group.invites },
              });
            }
          }
        }
      } else if (fmt === "standard") {
        // Persist shared slides under '__shared__' handle so we can look up later
        for (const slide of body.sharedSlides) {
          await sessions.addCreative(session.id, {
            pageHandle: "__shared__",
            mediaUrl:   slide.url,
            mediaType:  slide.type,
            metadata:   { format: "standard", label: slide.label },
          });
        }
      } else if (fmt === "hybrid") {
        // Per-page covers (always images at this layer; type=image baked-in)
        for (const page of (body.pages || [])) {
          if (page.coverUrl) {
            await sessions.addCreative(session.id, {
              pageHandle: page.handle.replace(/^@/, "").toLowerCase(),
              mediaUrl:   page.coverUrl,
              mediaType:  inferType(page.coverUrl),
              metadata:   { format: "hybrid", role: "cover" },
            });
          }
        }
        // Shared content slides (typed)
        for (const slide of body.sharedSlides) {
          await sessions.addCreative(session.id, {
            pageHandle: "__shared__",
            mediaUrl:   slide.url,
            mediaType:  slide.type,
            metadata:   { format: "hybrid", role: "content", label: slide.label },
          });
        }
      } else {
        // per-page (no shared slides)
        for (const page of (body.pages || [])) {
          // Accept either coverUrl (new from /bulk batches) or creativeUrl (legacy)
          const url = page.creativeUrl || page.coverUrl;
          if (url) {
            await sessions.addCreative(session.id, {
              pageHandle: page.handle.replace(/^@/, "").toLowerCase(),
              mediaUrl:   url,
              mediaType:  inferType(url),
              headline:   page.headline,
              metadata:   { price: page.price ?? body.campaign.basePrice, utmUrl: page.utmUrl },
            });
          }
        }
      }

      // Branch on requireApproval:
      //   true  → contributor flow: post review card to Sales Team chat,
      //           don't fire the cancel-window timer yet. A full sales
      //           user taps Approve to flip the session to 'pending'
      //           and run the regular intake pipeline.
      //   false → standard flow: send cancel-window notification + schedule
      try {
        if (rawBody.requireApproval === true) {
          // Promote session status to 'pending_review' so other queries
          // (active session lookups etc.) treat it correctly.
          await sessions.updateSession(session.id, {
            status: "pending_review",
            step: "pending_review",
          });
          // Late-resolve poster to avoid circular require
          const poster = require("./poster");
          const posted = await poster.postReviewCard(bot, { ...session, status: "pending_review" }, body);
          if (!posted) {
            // Couldn't post the review card (likely SALES_TEAM_CHAT_ID
            // not configured). Roll back so the contributor knows the
            // submission didn't land.
            await sessions.expireSession(session.id);
            return send(res, 503, {
              error: "Review queue not configured (SALES_TEAM_CHAT_ID missing on Greg)",
            });
          }
        } else {
          await handleIntake({ session, payload: body, bot });
        }
      } catch (e) {
        console.error("[api] intake handoff error:", e.message);
        await sessions.expireSession(session.id);
        return send(res, 500, { error: "intake processing failed", details: e.message });
      }

      // Count unique pages across formats (collab derives from videos[].groups[])
      const pageCount = body.format === "collab"
        ? new Set(
            (body.videos || [])
              .flatMap((v) => (v.groups || []).flatMap((g) => [g.host, ...(g.invites || [])]))
              .filter(Boolean)
              .map((h) => String(h).replace(/^@/, "").toLowerCase()),
          ).size
        : (body.pages?.length || 0);

      const isReview = rawBody.requireApproval === true;
      return send(res, 202, {
        accepted: true,
        sessionId: session.id,
        status: isReview ? "pending_review" : "scheduled",
        cancelUntil: session.cancel_until,
        message: isReview
          ? `Ad submitted for sales review (${pageCount} page${pageCount === 1 ? "" : "s"}). The team will get a review card; you'll be DM'd on approve/reject.`
          : `Ad scheduled for ${pageCount} page(s). Notification sent to admin.`,
      });
    }

    // ── POST /api/ad/approve  ───────────────────────────────────────────
    // Flip a pending_review session to pending and start the regular
    // cancel-window flow. Caller passes { sessionId, approverTelegramId }.
    if (method === "POST" && url === "/api/ad/approve") {
      let body;
      try { body = await readBody(req); }
      catch (e) { return send(res, 400, { error: e.message }); }
      const { sessionId, approverTelegramId } = body || {};
      if (!sessionId) return send(res, 400, { error: "sessionId required" });

      const poster = require("./poster");
      const result = await poster.approveSession(bot, sessionId, approverTelegramId || null);
      if (!result.ok) return send(res, 400, { error: result.error });
      return send(res, 200, { ok: true, sessionId: result.sessionId });
    }

    // ── POST /api/ad/reject ─────────────────────────────────────────────
    // Mark a pending_review session cancelled and DM the contributor with
    // the rejection note. { sessionId, approverTelegramId, reason }
    if (method === "POST" && url === "/api/ad/reject") {
      let body;
      try { body = await readBody(req); }
      catch (e) { return send(res, 400, { error: e.message }); }
      const { sessionId, approverTelegramId, reason } = body || {};
      if (!sessionId) return send(res, 400, { error: "sessionId required" });

      const poster = require("./poster");
      const result = await poster.rejectSession(bot, sessionId, approverTelegramId || null, reason || "");
      if (!result.ok) return send(res, 400, { error: result.error });
      return send(res, 200, { ok: true, sessionId: result.sessionId });
    }

    // ── POST /api/ad/posted ─────────────────────────────────────────────
    if (method === "POST" && url === "/api/ad/posted") {
      let body;
      try { body = await readBody(req); }
      catch (e) { return send(res, 400, { error: e.message }); }

      const { pageHandle, igUrl, igPostId } = body || {};
      if (!pageHandle || !igUrl) {
        return send(res, 400, { error: "pageHandle and igUrl required" });
      }

      const candidates = await sessions.findScheduledByHandle(pageHandle, { limit: 1 });
      if (candidates.length === 0) {
        return send(res, 404, { error: `no scheduled ad found for @${pageHandle}` });
      }

      const ad = candidates[0];
      await sessions.markPostedLive(ad.id, { igUrl, igPostId: igPostId || null });

      // Best-effort sheet update — don't fail the API call if it errors
      try {
        const { updateStatusToLive } = require("../sheets");
        if (process.env.MASTER_SHEET_ID) {
          await updateStatusToLive(
            process.env.MASTER_SHEET_ID,
            process.env.SHEET_TAB_NAME || "2026 Ad Overview",
            [pageHandle],
            ad.client_name
          );
        }
      } catch (e) {
        console.error("[api] sheet update error:", e.message);
      }

      return send(res, 200, {
        marked: true,
        pageHandle,
        clientName: ad.client_name,
        adId: ad.id,
      });
    }

    // ── 404 ──────────────────────────────────────────────────────────────
    return send(res, 404, { error: "not found" });
  });

  return server;
}

/**
 * Start the API server on the configured port.
 */
function startServer({ bot, handleIntake }) {
  const server = createServer({ bot, handleIntake });
  server.listen(PORT, () => {
    console.log(`✅ Greg HTTP API listening on port ${PORT}`);
  });
  return server;
}

module.exports = { createServer, startServer, PORT };
