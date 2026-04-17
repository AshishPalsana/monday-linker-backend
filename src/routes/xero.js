const express = require("express");
const router = express.Router();
const { XeroClient } = require("xero-node");
const prisma = require("../lib/prisma");
const xeroService = require("../services/xeroService");

// ── Shared XeroClient instance (used only for OAuth flow) ──────────────────
const xero = new XeroClient({
  clientId: process.env.XERO_CLIENT_ID,
  clientSecret: process.env.XERO_CLIENT_SECRET,
  redirectUris: [process.env.XERO_REDIRECT_URI],
  scopes: [
    "openid",
    "profile",
    "email",
    "accounting.transactions",
    "accounting.contacts",
    "projects",
    "offline_access",
  ],
});

/**
 * GET /api/xero/status
 * Check if the Xero integration is connected and the token is still valid.
 */
router.get("/status", async (req, res) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { provider: "XERO" },
    });

    if (!integration || !integration.accessToken) {
      return res.json({ connected: false });
    }

    const now = Date.now();
    const expiresAt = Number(integration.expiresAt);
    const isExpired = now >= expiresAt;
    const needsRefresh = !isExpired && now >= expiresAt - 5 * 60 * 1000; // within 5 min

    res.json({
      connected: !isExpired,
      needsRefresh,
      tenantName: integration.tenantName || null,
      lastSync: integration.updatedAt,
    });
  } catch (err) {
    console.error("[xero] /status error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/xero/connect
 * Generate the Xero OAuth2 consent URL.
 */
router.get("/connect", async (req, res) => {
  try {
    const consentUrl = await xero.buildConsentUrl();
    res.json({ url: consentUrl });
  } catch (err) {
    console.error("[xero] /connect error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/xero/callback
 * Handle the OAuth2 callback from Xero. Stores tokens in DB.
 */
router.get("/callback", async (req, res) => {
  try {
    const tokenSet = await xero.apiCallback(req.url);
    await xero.updateTenants();

    const activeTenant = xero.tenants[0];
    if (!activeTenant) {
      return res.status(400).send("No Xero organisation found. Please check your Xero account.");
    }

    await prisma.integration.upsert({
      where: { provider: "XERO" },
      update: {
        accessToken: tokenSet.access_token,
        refreshToken: tokenSet.refresh_token,
        idToken: tokenSet.id_token || null,
        tokenType: tokenSet.token_type || "Bearer",
        expiresAt: BigInt(Date.now() + (tokenSet.expires_in || 1800) * 1000),
        tenantId: activeTenant.tenantId,
        tenantName: activeTenant.tenantName || null,
      },
      create: {
        provider: "XERO",
        accessToken: tokenSet.access_token,
        refreshToken: tokenSet.refresh_token,
        idToken: tokenSet.id_token || null,
        tokenType: tokenSet.token_type || "Bearer",
        expiresAt: BigInt(Date.now() + (tokenSet.expires_in || 1800) * 1000),
        tenantId: activeTenant.tenantId,
        tenantName: activeTenant.tenantName || null,
      },
    });

    console.log(`[xero] ✓ Connected — tenant: ${activeTenant.tenantName} (${activeTenant.tenantId})`);

    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center;">
        <h2>✅ Xero Connected Successfully</h2>
        <p>Organisation: <strong>${activeTenant.tenantName}</strong></p>
        <p>This window will redirect back to the app shortly...</p>
        <script>
          const origin = window.location.origin.replace(':3001', ':5173');
          setTimeout(() => { 
            window.location.href = origin + '/#/settings/integrations?success=true';
          }, 2000);
        </script>
      </body></html>
    `);
  } catch (err) {
    console.error("[xero] /callback error:", err.message);
    res.status(500).send(`<h2>Error connecting to Xero</h2><p>${err.message}</p>`);
  }
});

/**
 * POST /api/xero/disconnect
 * Remove the stored Xero tokens from DB.
 */
router.post("/disconnect", async (req, res) => {
  try {
    await prisma.integration.delete({ where: { provider: "XERO" } });
    res.json({ success: true, message: "Xero disconnected." });
  } catch (err) {
    if (err.code === "P2025") {
      return res.json({ success: true, message: "Already disconnected." });
    }
    console.error("[xero] /disconnect error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/xero/status
 * Check if Xero is connected and return tenant info.
 */
router.get("/status", async (req, res) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { provider: "XERO" },
    });

    if (!integration || !integration.accessToken) {
      return res.json({ connected: false });
    }

    res.json({
      connected: true,
      tenantName: integration.tenantName,
    });
  } catch (err) {
    console.error("[xero] /status error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get("/sync-status/:mondayItemId", async (req, res) => {
  const { mondayItemId } = req.params;
  try {
    if (!prisma.workOrderSync) {
      console.error("[xero] prisma.workOrderSync model is missing from generated client.");
      return res.status(500).json({ error: "Database client misconfigured (workOrderSync missing)" });
    }

    let record = await prisma.workOrderSync.findUnique({
      where: { mondayItemId: String(mondayItemId) },
    });

    if (!record) {
      console.log(`[xero] Sync record not found for ${mondayItemId}. Initializing...`);
      // We don't have the WO-ID yet, but we can initialize a skeleton record
      // The user will be able to 'Retry sync' which will then fetch details
      try {
        const { getWorkOrderDetails } = require("../lib/mondayClient");
        const wo = await getWorkOrderDetails(mondayItemId);
        const workOrderId = wo?.workOrderId || "WO-PENDING";

        record = await prisma.workOrderSync.create({
          data: {
            mondayItemId: String(mondayItemId),
            workOrderId: workOrderId,
            xeroStatus: "INPROGRESS",
          }
        });
      } catch (err) {
        console.warn(`[xero] Could not auto-initialize sync record: ${err.message}`);
        return res.json({ synced: false, pending: true, message: "Sync record not found and could not be initialized." });
      }
    }

    if (record.xeroProjectId) {
      return res.json({
        synced: true,
        xeroProjectId: record.xeroProjectId,
        workOrderId: record.workOrderId,
        xeroStatus: record.xeroStatus,
        xeroProjectUrl: `https://go.xero.com/projects/list`,
      });
    }

    return res.json({
      synced: false,
      pending: false,
      workOrderId: record.workOrderId,
      error: record.syncError || "Unknown error",
    });
  } catch (err) {
    console.error("[xero] /sync-status error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/xero/retry-sync/:mondayItemId
 * Retry the Xero Project creation for a failed WorkOrderSync record.
 */
router.post("/retry-sync/:mondayItemId", async (req, res) => {
  const { mondayItemId } = req.params;
  try {
    const record = await prisma.workOrderSync.findUnique({
      where: { mondayItemId: String(mondayItemId) },
    });

    if (!record) {
      return res.status(404).json({ error: "No sync record found for this Work Order." });
    }

    if (record.xeroProjectId) {
      return res.json({
        success: true,
        alreadySynced: true,
        xeroProjectId: record.xeroProjectId,
      });
    }

    // Retry the Xero Project creation
    const xeroProjectId = await xeroService.createXeroProject({
      workOrderId: record.workOrderId,
      workOrderName: record.workOrderId, // name available in record
    });

    if (!prisma.workOrderSync) {
      console.error("[xero] /retry-sync error: prisma.workOrderSync model is missing from generated client.");
      return res.status(500).json({ error: "Database client misconfigured (workOrderSync missing)" });
    }

    await prisma.workOrderSync.update({
      where: { mondayItemId: String(mondayItemId) },
      data: { xeroProjectId, syncError: null },
    });

    console.log(`[xero] ✓ Retry sync successful — xeroProjectId: ${xeroProjectId}`);
    res.json({ success: true, xeroProjectId });
  } catch (err) {
    console.error("[xero] /retry-sync error:", err.message);

    // Update DB error message
    if (prisma.workOrderSync) {
      await prisma.workOrderSync
        .update({
          where: { mondayItemId: String(mondayItemId) },
          data: { syncError: err.message },
        })
        .catch(() => { });
    }

    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
