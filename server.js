import { GoogleGenAI } from "@google/genai";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import express from "express";
import fetch from "node-fetch";

  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: '10mb' })); // For handling base64 image data

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

  // --- Gemini AI Config ---
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const genAI = geminiApiKey ? new GoogleGenAI(geminiApiKey) : null;
  if (!genAI) {
      console.warn("Gemini API key not configured. AI features will be disabled.");
  } else {
      console.log("GoogleGenAI initialized.");
  }

  // In-memory for demo; use Redis/DB in prod
  const txns = new Map();

  // --- Gemini AI Endpoints ---

  app.post("/generate-album-cover-prompt", async (req, res) => {
      if (!genAI) return res.status(503).send({ error: "AI service not configured." });

      const { imageData, imageMimeType, mood, styles } = req.body;
      if (!imageData || !imageMimeType || !mood || !styles) {
          return res.status(400).send({ error: "Missing parameters." });
      }

      try {
          const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
          const imagePart = { inlineData: { data: imageData, mimeType: imageMimeType } };

          const stylePrompts = [];
          if (styles.decade && styles.decade.length > 0) stylePrompts.push(`the decade aesthetic of the ${styles.decade.join(', ')}`);
          if (styles.genre && styles.genre.length > 0) stylePrompts.push(`the musical genre of ${styles.genre.join(', ')}`);
          if (styles.style) stylePrompts.push(`the artistic style of ${styles.style}`);

          const styleText = stylePrompts.length > 0 ?  ` Incorporate these styles: ${stylePrompts.join('; ')}.` : '';

          const prompt = `Analyze this photo "${mood}". Based on this, create a detailed, artistic, and visually rich prompt for an AI image generator to create a stunning album
  cover. The prompt should be a single paragraph that captures the photo's essence and the specified mood, ready to be fed directly into an image generation model.${styleText} Do not include any conversational text, just
  the prompt itself.`;

          const result = await model.generateContent([prompt, imagePart]);
          const response = result.response;
          const generatedText = response.text();

          if (!generatedText) {
              throw new Error("The AI response did not contain any text.");
          }
          res.json({ prompt: generatedText });
      } catch (error) {
          console.error("Error generating album cover prompt:", error);
          res.status(500).send({ error: "Error generating album cover prompt." });
      }
  });

  app.post("/edit-selfie-into-album-cover", async (req, res) => {
      if (!genAI) return res.status(503).send({ error: "AI service not configured." });

      const { imageData, imageMimeType, prompt } = req.body;
      if (!imageData || !imageMimeType || !prompt) {
          return res.status(400).send({ error: "Missing parameters." });
      }

      try {
          const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
          const imagePart = { inlineData: { data: imageData, mimeType: imageMimeType } };
          const textPart = `Transform this user's photo into a complete album cover based on the following artistic direction: "${prompt}". The final image should be a fully realized piece of art, with a square 1:1 aspect ratio,
  emulating famous album covers. The user's face must be clearly visible and integrated naturally into the artwork.`;

          const result = await model.generateContent([textPart, imagePart]);

          const response = result.response;
          const candidate = response?.candidates?.[0];
          const part = candidate?.content?.parts?.[0];

          if (part && part.inlineData) {
              res.json({
                  imageData: part.inlineData.data,
                  mimeType: part.inlineData.mimeType,
              });
          } else {
              console.error("Failed to extract image from Gemini response:", JSON.stringify(response, null, 2));
              const finishReason = candidate?.finishReason;
              if (finishReason && finishReason !== 'STOP') {
                  throw new Error(`Image generation stopped unexpectedly. Reason: ${finishReason}. This can happen due to safety settings.`);
              }
              throw new Error("No image was generated by the model. The response may have been empty or blocked.");
          }
      } catch (error) {
          console.error("Error editing selfie into album cover:", error);
          res.status(500).send({ error: `Error editing selfie into album cover: ${error.message}` });
      }
  });

  app.post("/generate-playlist-vibe", async (req, res) => {
      if (!genAI) return res.status(503).send({ error: "AI service not configured." });

      const { mood, albumPrompt, playlistLength } = req.body;
      if (!mood || !albumPrompt || !playlistLength) {
          return res.status(400).send({ error: "Missing parameters." });
      }

      try {
          const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
          const prompt = `Based on a user's mood of "${mood}" and an album cover described as "${albumPrompt}", create a 'playlist vibe'. Return a valid JSON object with three keys: "vibe" (a 1-2 sentence description of the
   overall mood), "genre" (a primary genre), and "songs" (an array of exactly ${playlistLength} objects, each with "title" and "artist").`;

          const result = await model.generateContent(prompt);

          const response = result.response;
          const generatedText = response.text();

          if (!generatedText) {
              throw new Error("The AI response did not contain any text.");
          }
          res.setHeader('Content-Type', 'application/json');
          res.send(generatedText);
      } catch (error) {
          console.error("Error generating playlist vibe:", error);
          res.status(500).send({ error: "Error generating playlist vibe." });
      }
  });


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



  // PACKAGE.JSON DEPENDENCIES:
//   {
//   "name": "auth-server",
//   "private": true,
//   "type": "module",
//   "scripts": { "start": "node server.js" },
//   "dependencies": {
//     "@google/genai": "^1.19.0",
//     "cookie-parser": "^1.4.6",
//     "express": "^4.19.2",
//     "node-fetch": "^3.3.2"
//   }
// }
