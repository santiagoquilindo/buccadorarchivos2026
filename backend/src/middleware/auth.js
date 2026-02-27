const jwt = require("jsonwebtoken");

const JWT_SECRET = "CAMBIA_ESTA_CLAVE_POR_UNA_LARGA_Y_UNICA";

function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ message: "No autenticado" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Token inválido" });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) return res.status(403).json({ message: "Prohibido" });
    next();
  };
}

module.exports = { requireAuth, requireRole, JWT_SECRET };