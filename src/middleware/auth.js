const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.technician = {
      id:      payload.sub,
      name:    payload.name,
      isAdmin: payload.isAdmin ?? false,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Token expired or invalid" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.technician?.isAdmin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
