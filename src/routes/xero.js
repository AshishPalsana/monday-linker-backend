const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { buildXeroClient, XERO_SCOPES } = require("../services/xeroService");


/**
 * GET /api/xero/status
 * Check if the Xero integration is connected and return tenant info.
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
      tenantName: integration.tenantName || "Connected",
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
/**
 * GET /api/xero/connect
 * Generate the Xero OAuth2 consent URL and redirect.
 */
router.get("/connect", async (req, res) => {
  try {
    const xero = buildXeroClient();
    
    // Stable state based on ID to ensure verification succeeds in stateless mode.
    const state = Buffer.from(process.env.XERO_CLIENT_ID || "xero").toString('base64').substring(0, 16);
    const consentUrl = await xero.buildConsentUrl(state);
    
    res.redirect(consentUrl);
  } catch (err) {
    console.error("[xero] /connect error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/xero/callback
 * Handle the OAuth2 callback from Xero.
 */
router.get("/callback", async (req, res) => {
  let callbackUrl = "N/A";
  try {
    const queryString = req.url.split('?')[1] || "";
    callbackUrl = `${process.env.XERO_REDIRECT_URI}?${queryString}`;
    
    console.log(`[xero] processing callback for: ${callbackUrl}`);

    const xero = buildXeroClient();
    const tokenSet = await xero.apiCallback(callbackUrl);
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

    console.log(`[xero] ✓ Connected — tenant: ${activeTenant.tenantName}`);

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
    const xeroBodyError = err.response?.body?.Message || err.response?.body?.error || err.response?.body?.error_description;
    const errorMessage = xeroBodyError || err.message || "An unknown Xero error occurred.";
    
    console.error("[xero] /callback error:", errorMessage);
    
    // Mask logic for verification
    const mask = (str) => {
      if (!str) return "MISSING";
      return str.substring(0, 3) + "..." + str.substring(str.length - 3);
    };

    const debugData = {
      errorMessage,
      xeroStatusCode: err.response?.statusCode,
      envVerification: {
        XERO_CLIENT_ID: mask(process.env.XERO_CLIENT_ID),
        XERO_REDIRECT_URI: process.env.XERO_REDIRECT_URI
      },
      callbackUrl
    };

    res.status(500).send(`
      <div style="font-family:sans-serif;padding:40px;text-align:center;max-width:900px;margin:auto;">
        <h2 style="color:#d32f2f;">Error connecting to Xero</h2>
        <p style="background:#f5f5f5;padding:15px;border-radius:6px;display:inline-block;">${errorMessage}</p>
        
        <div style="text-align:left; background:#1e1e1e; color:#d4d4d4; padding:20px; border-radius:8px; margin-top:20px; font-family:monospace; font-size:12px; overflow:auto; border: 1px solid #333;">
          <strong style="color:#ff8a80;">Diagnostics:</strong>
          <pre>${JSON.stringify(debugData, null, 2)}</pre>
          <hr style="border:0; border-top:1px solid #333; margin:15px 0;">
          <strong>Error Stack:</strong>
          <pre>${err.stack?.split("\n").slice(0, 5).join("\n")}</pre>
        </div>

        <br/><br/>
        <a href="/api/xero/connect" style="color:#13b5ea;text-decoration:none;font-weight:600;font-size:18px;">Click here to try again</a>
      </div>
    `);
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
