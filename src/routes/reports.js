const express = require("express");
const router = express.Router();
const { generateDailyNarrativeReport } = require("../services/reportService");
const { requireAdmin } = require("../middleware/auth");

router.get("/daily", requireAdmin, async (req, res, next) => {
  try {
    const date = req.query.date; // YYYY-MM-DD
    const report = await generateDailyNarrativeReport(date);
    res.json({ status: "success", report });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
