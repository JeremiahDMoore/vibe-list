import express from "express";
import fetch from "node-fetch";
import cookieParser from "cookie-parser";
import crypto from "crypto";

const app = express();
app.use(cookieParser());

// --- CONFIG ---
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

// in-memory for demo; use Redis/DB in prod
const txns = new Map();

// Start OAuth
app.get("/oauth/start", (req, res) => {
  const { provider, redirect } = req.query;
  if (!["spotify","google"].includes(provider)) return res.status(400).send("bad provider");
  if (!redirect || !/^https?:\/\/.+/i.test(redirect)) return res.status(400).send("bad redirect");

  const state = crypto.randomBytes(16).toString("hex");
  txns.set(state, { redirect });

  if (provider === "spotify") {
    const u = new URL(cfg.spotify.auth);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", cfg.spotify.clientId);
    u.searchParams.set("redirect_uri", cfg.spotify.redirectUri);
    u.searchParams.set("scope", cfg.spotify.scope);
    u.searchParams.set("state", state);
    return res.redirect(u.toString());
  } else {
    const u = new URL(cfg.google.auth);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", cfg.google.clientId);
    u.searchParams.set("redirect_uri", cfg.google.redirectUri);
    u.searchParams.set("scope", cfg.google.scope);
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("state", state);
    return res.redirect(u.toString());
  }
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
  return r.json();
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
  return r.json();
}

function finish(res, state, tokens) {
  const txn = txns.get(state);
  if (!txn) return res.status(400).send("bad state");
  txns.delete(state);
  // TODO: persist tokens securely for the logged-in user
  const url = new URL(txn.redirect);
  url.searchParams.set("ok", "1");
  res.redirect(url.toString());
}

// Callbacks
app.get("/callback/spotify", async (req, res) => {
  const { code, state } = req.query;
  const tokens = await exchangeSpotify(code);
  return finish(res, state, tokens);
});

app.get("/callback/google", async (req, res) => {
  const { code, state } = req.query;
  const tokens = await exchangeGoogle(code);
  return finish(res, state, tokens);
});

app.get("/", (_req, res) => res.send("OK"));
app.listen(process.env.PORT || 8080);
