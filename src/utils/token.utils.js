import jwt from "jsonwebtoken";
import crypto from "crypto";
import { config } from "../config/env.js";

export const generateAccessToken = (user) =>
  jwt.sign({ id: user._id, role: user.role }, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExp,
  });

export const generateRefreshToken = () => crypto.randomBytes(64).toString("hex");
export const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
export const generateClientKey = () => crypto.randomBytes(24).toString("hex");
