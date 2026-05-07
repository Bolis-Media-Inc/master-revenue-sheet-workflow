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

const http     = require("http");
const sessions = require("./sessions");

const GREG_API_SECRET = process.env.GREG_API_SECRET || process.env.DIGI_API_SECRET;
const PORT             = parseInt(process.env.GREG_API_PORT || process.env.PORT || "3001", 10);

if (!GREG_API_SECRET) {
  console.warn("[api] GREG_API_SECRET not set — HTTP API will reject all auth'd requests");
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
 * Validate an /api/ad/intake payload. Returns { valid, errors[] }.
 */
function validateIntake(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") {
    return { valid: false, errors: ["payload must be an object"] };
  }

  const { campaign, adInfo, pages, format, sharedCreativeUrl, collabGroups } = payload;

  if (!campaign?.client) errors.push("campaign.client is required");
  if (!campaign?.adType) errors.push("campaign.adType is required");
  if (campaign?.basePrice == null) errors.push("campaign.basePrice is required");

  if (!adInfo?.time) errors.push("adInfo.time is required");
  if (!adInfo?.postType) errors.push("adInfo.postType is required");
  if (!adInfo?.duration) errors.push("adInfo.duration is required");

  // Format-specific validation
  const fmt = format || "per-page";
  if (!["per-page", "standard", "collab"].includes(fmt)) {
    errors.push(`format must be one of: per-page, standard, collab (got '${fmt}')`);
  }

  if (fmt === "collab") {
    // Collab uses collabGroups; pages[] is optional (can be derived from groups)
    if (!Array.isArray(collabGroups) || collabGroups.length === 0) {
      errors.push("collabGroups must be a non-empty array for format=collab");
    } else {
      collabGroups.forEach((g, i) => {
        if (!g.host) errors.push(`collabGroups[${i}].host is required`);
        if (!Array.isArray(g.invites) || g.invites.length === 0) {
          errors.push(`collabGroups[${i}].invites must be a non-empty array`);
        }
        if (!g.creativeUrl) {
          errors.push(`collabGroups[${i}].creativeUrl is required`);
        }
      });
    }
  } else if (fmt === "standard") {
    if (!sharedCreativeUrl) {
      errors.push("sharedCreativeUrl is required for format=standard");
    }
    if (!Array.isArray(pages) || pages.length === 0) {
      errors.push("pages must be a non-empty array");
    } else {
      pages.forEach((p, i) => {
        if (!p.handle) errors.push(`pages[${i}].handle is required`);
      });
    }
  } else {
    // per-page
    if (!Array.isArray(pages) || pages.length === 0) {
      errors.push("pages must be a non-empty array");
    } else {
      pages.forEach((p, i) => {
        if (!p.handle) errors.push(`pages[${i}].handle is required`);
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

    // ── POST /api/ad/intake ─────────────────────────────────────────────
    if (method === "POST" && url === "/api/ad/intake") {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return send(res, 400, { error: e.message });
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

      // Create session in Supabase
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

      // Persist creatives based on format
      const fmt = body.format || "per-page";
      const mediaType = (url) => /\.(mp4|mov)$/i.test(url) ? "video" : "image";

      if (fmt === "standard" && body.sharedCreativeUrl) {
        // One row tagged with the special handle '__shared__' so the poster
        // knows to use it for every targeted page
        await sessions.addCreative(session.id, {
          pageHandle: "__shared__",
          mediaUrl:   body.sharedCreativeUrl,
          mediaType:  mediaType(body.sharedCreativeUrl),
          headline:   null,
          metadata:   { format: "standard" },
        });
      } else if (fmt === "collab" && Array.isArray(body.collabGroups)) {
        // One creative per collab group, indexed by host handle
        for (const group of body.collabGroups) {
          if (!group.creativeUrl) continue;
          await sessions.addCreative(session.id, {
            pageHandle: group.host.replace(/^@/, "").toLowerCase(),
            mediaUrl:   group.creativeUrl,
            mediaType:  mediaType(group.creativeUrl),
            headline:   group.headline || null,
            metadata:   {
              format: "collab",
              host:   group.host,
              invites: group.invites,
            },
          });
        }
      } else {
        // per-page: one creative per page
        for (const page of (body.pages || [])) {
          if (page.creativeUrl) {
            await sessions.addCreative(session.id, {
              pageHandle: page.handle,
              mediaUrl:   page.creativeUrl,
              mediaType:  mediaType(page.creativeUrl),
              headline:   page.headline,
              metadata:   { price: page.price ?? body.campaign.basePrice },
            });
          }
        }
      }

      // Hand off to wizard's posting pipeline (handles auto-approve flow,
      // sends notification, schedules send after cancel window)
      try {
        await handleIntake({ session, payload: body, bot });
      } catch (e) {
        console.error("[api] handleIntake error:", e.message);
        await sessions.expireSession(session.id);
        return send(res, 500, { error: "intake processing failed", details: e.message });
      }

      return send(res, 202, {
        accepted: true,
        sessionId: session.id,
        status: "scheduled",
        cancelUntil: session.cancel_until,
        message: `Ad scheduled for ${body.pages.length} page(s). Notification sent to admin.`,
      });
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
