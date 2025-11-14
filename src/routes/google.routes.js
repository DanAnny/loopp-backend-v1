import express from "express";
import { requireAuth, optionalAuth } from "../middleware/auth.middleware.js";
import { getGoogleAuthUrl, exchangeCodeForTokens } from "../services/google.service.js";
import { User } from "../models/User.js";

const router = express.Router();

// 1) Start OAuth flow – must be logged in to Loopp
router.get("/oauth2/connect", requireAuth, async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const url = getGoogleAuthUrl(userId);
    return res.json({ success: true, url });
  } catch (err) {
    console.error("GET /google/oauth2/connect error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to start Google connect" });
  }
});

// 2) Redirect URI – Google sends ?code=... here
router.get("/oauth2/callback", optionalAuth, async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing ?code");

    // 1) Prefer userId from Google `state`
    const stateUserId = req.query.state;

    // 2) Fallback to whatever optionalAuth managed to put on req.user
    const baseUser = req.user || {};
    const authUserId = baseUser._id || baseUser.id;

    const userId = stateUserId || authUserId;

    if (!userId) {
      return res
        .status(401)
        .send(
          "You must be logged into Loopp before connecting Google. " +
            "Close this tab and start the connect flow from the app again."
        );
    }

    const tokens = await exchangeCodeForTokens(code);

    if (!tokens.refresh_token) {
      return res
        .status(400)
        .send(
          "Google did not send a refresh token. " +
            "Remove Loopp from your Google account permissions and try again."
        );
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).send("User not found");

    user.googleRefreshToken = tokens.refresh_token;
    await user.save({ validateBeforeSave: false });

    return res.send(`
      <html>
        <body style="font-family: system-ui; text-align:center; padding-top:40px;">
          <h2>Google connected ✅</h2>
          <p>You can now create Google Meet links from Loopp chat.</p>
          <button onclick="window.close()" style="
            margin-top:20px;
            padding:8px 16px;
            border-radius:999px;
            border:none;
            background:black;
            color:white;
            cursor:pointer;
          ">Close this window</button>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("GET /google/oauth2/callback error:", err);
    return res.status(500).send("Failed to connect Google");
  }
});

export default router;
