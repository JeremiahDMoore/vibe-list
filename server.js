import express from "express";
import fetch from "node-fetch";
import cookieParser from "cookie-parser";
import crypto from "crypto";

const app = express();
app.use(cookieParser());

// --- CONFIG ---
// Load from environment variables
const cfg = {
  spotify: {
    auth: "https://accounts.spotify.com/authorize",
    token: "https://accounts.spotify.com/api/token",
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    redirectUri: process.env.SPOTIFY_REDIRECT_URI,
    scope: "playlist-modify-public playlist-modify-private ugc-image-upload"
  },
  google: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
    scope: "https://www.googleapis.com/auth/youtube"
  }
};

// In-memory for demo; use Redis/DB in prod
const txns = new Map();

// Start OAuth
app.get("/oauth/start", (req, res) => {
  const { provider, redirect } = req.query;
  if (!["spotify","google"].includes(provider)) return res.status(400).send("bad provider");
  if (!redirect || !/^https?:\/\/.+/i.test(redirect)) return res.status(400).send("bad redirect");

  const state = crypto.randomBytes(16).toString("hex");
  txns.set(state, { redirect });

  let authUrl;
  if (provider === "spotify") {
    const u = new URL(cfg.spotify.auth);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", cfg.spotify.clientId);
    u.searchParams.set("redirect_uri", cfg.spotify.redirectUri);
    u.searchParams.set("scope", cfg.spotify.scope);
    u.searchParams.set("state", state);
    u.searchParams.set("show_dialog", "true");
    authUrl = u.toString();
  } else { // provider === "google"
    const u = new URL(cfg.google.auth);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", cfg.google.clientId);
    u.searchParams.set("redirect_uri", cfg.google.redirectUri);
    u.searchParams.set("scope", cfg.google.scope);
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("state", state);
    authUrl = u.toString();
  }
  return res.redirect(authUrl);
});

// Token exchange helpers
async function exchangeSpotify(code) {
  const r = await fetch(cfg.spotify.token, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(
        cfg.spotify.clientId + ":" + cfg.spotify.clientSecret
      ).toString("base64")
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.spotify.redirectUri
    })
  });
  const data = await r.json();
  if (!r.ok) {
    console.error("Spotify token exchange failed:", r.status, data);
    return { error: data.error_description || data.error || 'Failed to exchange token with Spotify' };
  }
  return data;
}

async function exchangeGoogle(code) {
  const r = await fetch(cfg.google.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: cfg.google.clientId,
      client_secret: cfg.google.clientSecret,
      redirect_uri: cfg.google.redirectUri
    })
  });
   const data = await r.json();
   if (!r.ok) {
    console.error("Google token exchange failed:", r.status, data);
    return { error: data.error_description || data.error || 'Failed to exchange token with Google' };
  }
  return data;
}

// Respond with a page that posts a message to the opener window and closes itself.
function finish(res, state, data, provider, isError = false) {
    const txn = txns.get(state);
    if (!txn) {
        return res.status(400).send(`
            <html><body>
                <h2>Error</h2>
                <p>Invalid state parameter. This may be a sign of a CSRF attack. Please close this window and try again.</p>
            </body></html>
        `);
    }
    txns.delete(state);

    const result = { provider };
    if (isError) {
        result.error = data.error || 'An unknown error occurred.';
    } else {
        result.token = data.access_token;
    }
    
    // The targetOrigin should be the URL of the frontend that initiated the request
    const targetOrigin = new URL(txn.redirect).origin;

    const script = `
        <script>
            if (window.opener) {
                window.opener.postMessage(${JSON.stringify(result)}, '${targetOrigin}');
            }
            window.close();
        </script>
    `;

    const message = isError ? `Authentication failed: ${result.error}` : 'Authentication successful!';
    
    res.send(`
        <html>
            <head><title>Authentication Complete</title></head>
            <body>
                <p>${message} You can close this window now.</p>
                ${script}
            </body>
        </html>
    `);
}


// Callbacks
app.get("/callback/spotify", async (req, res) => {
  const { code, state, error } = req.query;
  if (!state) return res.status(400).send("Missing state from Spotify callback.");
  
  if (error) {
    console.error("Spotify returned an error:", error);
    return finish(res, state, { error }, 'spotify', true);
  }
  if (!code) return finish(res, state, { error: 'Missing code from Spotify callback.' }, 'spotify', true);

  const tokens = await exchangeSpotify(code);
  if (tokens.error || !tokens.access_token) {
    return finish(res, state, { error: tokens.error }, 'spotify', true);
  }
  return finish(res, state, tokens, 'spotify');
});

app.get("/callback/google", async (req, res) => {
  const { code, state, error } = req.query;
  if (!state) return res.status(400).send("Missing state from Google callback.");
  
  if (error) {
    console.error("Google returned an error:", error);
    return finish(res, state, { error }, 'google', true);
  }
  if (!code) return finish(res, state, { error: 'Missing code from Google callback.' }, 'google', true);

  const tokens = await exchangeGoogle(code);
  if (tokens.error || !tokens.access_token) {
    return finish(res, state, { error: tokens.error }, 'google', true);
  }
  return finish(res, state, tokens, 'google');
});

app.get("/", (_req, res) => res.send("OK"));

const port = process.env.PORT || 10000;
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Auth server listening on port ${port}`);
});

// Increase timeouts to prevent intermittent 502s on some platforms
server.keepAliveTimeout = 120 * 1000;
server.headersTimeout = 120 * 1000;
