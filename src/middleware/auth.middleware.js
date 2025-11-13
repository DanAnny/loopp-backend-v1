import passport from "passport";
import jwt from "jsonwebtoken";
import { config } from "../config/env.js";

function getTokenFromCookies(req) {
  return req.cookies?.at || req.cookies?.rt || null;
}
function shapeUserFromPayload(payload) {
  const id = payload?.id || payload?._id || payload?.userId || payload?.sub || payload?.uid || null;
  const role = payload?.role || payload?.kind || "User";
  const kind = payload?.kind || (role?.toLowerCase?.() === "staff" ? "staff" : "user");
  const email = payload?.email || payload?.mail || undefined;
  return { _id: id, id, role, kind, email };
}

export const requireAuth = (req, res, next) =>
  passport.authenticate("jwt", { session: false }, (err, user) => {
    if (err) return res.status(401).json({ success: false, message: "Unauthorized" });
    if (user) {
      req.user = user;
      return next();
    }
    // Fallback: cookie token for top-level nav / <img src> etc.
    try {
      const token = getTokenFromCookies(req);
      if (!token) throw new Error("no token");
      const payload = jwt.verify(token, config.jwtSecret);
      req.user = shapeUserFromPayload(payload);
      return next();
    } catch {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
  })(req, res, next);

export const optionalAuth = (req, res, next) =>
  passport.authenticate("jwt", { session: false }, (_err, user) => {
    if (user) req.user = user;
    else {
      try {
        const t = getTokenFromCookies(req);
        if (t) req.user = shapeUserFromPayload(jwt.verify(t, config.jwtSecret));
      } catch {}
    }
    return next();
  })(req, res, next);
