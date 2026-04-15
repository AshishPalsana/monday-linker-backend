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
    const fullAddress = `${address}, ${city}, ${state} ${zip}`;
    const response = await client.post("/projects", {
      name,
      address: {
        street_address_1: address,
        city,
        state,
        postal_code: zip,
      }
    });
    console.log(`[companyCamService] Created project: ${response.data.id}`);
    return response.data;
  } catch (err) {
    console.error("[companyCamService] Error creating project:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Creates a Report (or checklist/document) under a project
 */
async function createProjectReport(projectId, { title, description }) {
  const client = getClient();
  if (!client) return null;

  try {
    // Note: CompanyCam might use different endpoints for "reports" vs "checklists"
    // Assuming a general "project note" or similar if the report API is specific
    console.log(`[companyCamService] Creating report "${title}" for project ${projectId}...`);
    // Placeholder for actual report creation endpoint
    // const res = await client.post(`/projects/${projectId}/reports`, { title, description });
    // return res.data;
    return { id: "mock-report-id", title };
  } catch (err) {
    console.error("[companyCamService] Error creating report:", err.response?.data || err.message);
    throw err;
  }
}

module.exports = {
  createProject,
  createProjectReport,
};
