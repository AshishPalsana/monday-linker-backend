const axios = require("axios");

const CC_API_URL = "https://api.companycam.com/v2";

function getClient() {
  const token = process.env.COMPANYCAM_API_TOKEN;
  if (!token) {
    console.warn("[companyCamService] COMPANYCAM_API_TOKEN is not set.");
    return null;
  }
  return axios.create({
    baseURL: CC_API_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

/**
 * Creates a Project (Location) in CompanyCam
 */
async function createProject({ name, address, city, state, zip }) {
  const client = getClient();
  if (!client) return null;

  try {
    const response = await client.post("/projects", {
      name,
      address: {
        street_address_1: address || undefined,
        city: city || undefined,
        state: state || undefined,
        postal_code: zip || undefined,
      }
    });
    console.log(`[companyCamService] Created project: ${response.data.id}`);
    return response.data;
  } catch (err) {
    const errorBody = err.response?.data;
    console.error("[companyCamService] Error creating project:", errorBody || err.message);
    throw new Error(errorBody?.errors?.[0]?.message || err.message);
  }
}

/**
 * Creates a blank Report under a project
 */
async function createProjectReport(projectId, { title }) {
  const client = getClient();
  if (!client) return null;

  try {
    console.log(`[companyCamService] Creating report "${title}" for project ${projectId}...`);
    
    // Per CC API: POST /reports requires project_id and title
    const response = await client.post(`/reports`, {
      project_id: projectId,
      title: title
    });

    console.log(`[companyCamService] ✓ Report created: ${response.data.id}`);
    return response.data;
  } catch (err) {
    const errorBody = err.response?.data;
    console.error("[companyCamService] Error creating report:", errorBody || err.message);
    throw new Error(errorBody?.errors?.[0]?.message || err.message);
  }
}

/**
 * Updates a Project's name and address in CompanyCam
 */
async function updateProject(projectId, { name, address, city, state, zip }) {
  const client = getClient();
  if (!client) return null;

  try {
    const response = await client.put(`/projects/${projectId}`, {
      name,
      address: {
        street_address_1: address || undefined,
        city: city || undefined,
        state: state || undefined,
        postal_code: zip || undefined,
      },
    });
    console.log(`[companyCamService] ✓ Updated project ${projectId}`);
    return response.data;
  } catch (err) {
    const errorBody = err.response?.data;
    console.error("[companyCamService] Error updating project:", errorBody || err.message);
    throw new Error(errorBody?.errors?.[0]?.message || err.message);
  }
}

/**
 * Archives a project in CompanyCam
 */
async function archiveProject(projectId) {
  const client = getClient();
  if (!client) return null;
  try {
    console.log(`[companyCamService] Archiving Project ${projectId}...`);
    const response = await client.patch(`/projects/${projectId}/archive`);
    return response.data;
  } catch (err) {
    console.error("[companyCamService] Error archiving project:", err.response?.data || err.message);
    // We don't necessarily want to throw if it's already archived
  }
}

/**
 * Restores an archived project in CompanyCam
 */
async function restoreProject(projectId) {
  const client = getClient();
  if (!client) return null;
  try {
    console.log(`[companyCamService] Restoring Project ${projectId}...`);
    const response = await client.put(`/projects/${projectId}/restore`);
    return response.data;
  } catch (err) {
    console.error("[companyCamService] Error restoring project:", err.response?.data || err.message);
    // We don't necessarily want to throw if it's already restored
  }
}

/**
 * Centralized logic to sync a Monday Location item to CompanyCam.
 * To be used by both webhooks and direct API calls.
 */
async function syncLocation(pulseId, initialData = null) {
  const prisma = require("../lib/prisma");
  const { getLocationDetails } = require("../lib/mondayClient");

  console.log(`[companyCamService] syncLocation triggered for pulse ${pulseId}`);
  
  // 0. Wait a moment for Monday to process the new item (indexing delay)
  await new Promise(r => setTimeout(r, 2000));

  try {
    // 1. Fetch location details from Monday (or use provided initial data)
    let loc = initialData ? {
      name: initialData.name,
      streetAddress: initialData.streetAddress || "",
      city: initialData.city || "",
      state: initialData.state || "",
      zip: initialData.zip || "",
      locationStatus: initialData.locationStatus || ""
    } : null;

    if (!loc) {
      loc = await getLocationDetails(pulseId);
      
      // Simple one-time retry if data is suspiciously empty
      if (!loc || (!loc.streetAddress && !loc.city)) {
        console.log(`[companyCamService] Data for ${pulseId} looked empty, retrying in 3s...`);
        await new Promise(r => setTimeout(r, 3000));
        loc = await getLocationDetails(pulseId);
      }
    }

    if (!loc) {
      console.warn(`[companyCamService] Could not fetch details for item ${pulseId}. Skipping sync.`);
      return null;
    }

    // 2. Check if already synced in our DB
    let mapping = await prisma.locationSync.findUnique({
      where: { mondayItemId: String(pulseId) }
    });

    if (mapping && mapping.companyCamProjectId) {
      console.log(`[companyCamService] Item ${pulseId} already has CompanyCam Project ${mapping.companyCamProjectId} — updating details.`);

      // Push updated name and address to CompanyCam
      await updateProject(mapping.companyCamProjectId, {
        name: loc.name,
        address: loc.streetAddress,
        city: loc.city,
        state: loc.state,
        zip: loc.zip,
      }).catch((err) =>
        console.warn(`[companyCamService] Could not update CC project details for ${mapping.companyCamProjectId}:`, err.message)
      );

      // Handle archive/restore based on status
      if (loc.locationStatus === "Inactive") {
        await archiveProject(mapping.companyCamProjectId);
      } else if (loc.locationStatus === "Active") {
        await restoreProject(mapping.companyCamProjectId);
      }

      return mapping.companyCamProjectId;
    }

    // 3. Create Project in CompanyCam
    // Note: CompanyCam API V2 documentation confirms name is the only required field.
    console.log(`[companyCamService] Sending to CompanyCam:`, { name: loc.name, address: loc.streetAddress, status: loc.locationStatus });
    
    const ccProject = await createProject({
      name: loc.name,
      address: loc.streetAddress,
      city: loc.city,
      state: loc.state,
      zip: loc.zip
    });

    if (ccProject && ccProject.id) {
      // 4. Save mapping in DB
      mapping = await prisma.locationSync.upsert({
        where: { mondayItemId: String(pulseId) },
        update: { companyCamProjectId: String(ccProject.id) },
        create: {
          mondayItemId: String(pulseId),
          companyCamProjectId: String(ccProject.id)
        }
      });
      
      // Handle status if created as Inactive
      if (loc.locationStatus === "Inactive") {
        await archiveProject(ccProject.id);
      }

      console.log(`[companyCamService] ✓ Item ${pulseId} synced to CompanyCam Project ${ccProject.id}`);
      return ccProject.id;
    } else {
      throw new Error("CompanyCam Project creation returned no ID.");
    }

  } catch (err) {
    console.error(`[companyCamService] ✗ syncLocation failed for pulse ${pulseId}:`, err.message);
    throw err;
  }
}

module.exports = {
  createProject,
  createProjectReport,
  syncLocation,
};
