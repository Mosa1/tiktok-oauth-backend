require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI; // must match EXACTLY what's registered in TikTok portal

// Parse JSON bodies. Without this, req.body is undefined in Express 5 and
// the destructure in /post throws a TypeError before any of the logic runs.
app.use(express.json());

// Serve /video/video.mp4 (and anything else dropped in ./video) as static
// files. TikTok's PULL_FROM_URL fetches the video over HTTPS from here, so
// this has to be publicly reachable with no redirect and no auth.
app.use('/video', express.static(path.join(__dirname, 'video'), {
  setHeaders: (res) => res.setHeader('Content-Type', 'video/mp4'),
}));

// TikTok URL-prefix ownership verification. Drop the .txt file TikTok gives
// you into ./public and it is served at the root, which is where TikTok
// looks for it. Required before PULL_FROM_URL will accept any URL on this host.
app.use('/', express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Token handling
//
// Render's free tier spins the instance down when idle and wipes memory, so
// holding tokens only in a module variable means /post starts returning 401
// a few minutes after every login. Tokens are cached on disk and, failing
// that, rebuilt from a TIKTOK_REFRESH_TOKEN env var, so a cold start recovers
// on its own instead of needing a manual re-auth.
// ---------------------------------------------------------------------------

const TOKEN_CACHE = path.join(__dirname, '.tokens.json');

let storedTokens = null;
try {
  if (fs.existsSync(TOKEN_CACHE)) {
    storedTokens = JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf8'));
    console.log('Loaded cached tokens from disk.');
  }
} catch (err) {
  console.warn('Could not read token cache:', err.message);
}

function persistTokens(tokens) {
  storedTokens = { ...tokens, obtained_at: Math.floor(Date.now() / 1000) };
  try {
    fs.writeFileSync(TOKEN_CACHE, JSON.stringify(storedTokens), { mode: 0o600 });
  } catch (err) {
    // Read-only or ephemeral disk: not fatal, we still have it in memory.
    console.warn('Could not persist tokens:', err.message);
  }
  return storedTokens;
}

async function refreshWith(refreshToken) {
  const resp = await axios.post(
    'https://open.tiktokapis.com/v2/oauth/token/',
    new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  // TikTok rotates the refresh token — always keep whatever came back.
  return persistTokens(resp.data);
}

// Returns a usable access token, refreshing or bootstrapping as needed.
async function getAccessToken() {
  const age = storedTokens
    ? Math.floor(Date.now() / 1000) - (storedTokens.obtained_at || 0)
    : Infinity;

  if (storedTokens?.access_token && age < 23 * 3600) {
    return storedTokens.access_token;
  }

  const refreshToken = storedTokens?.refresh_token || process.env.TIKTOK_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error('NOT_AUTHENTICATED');
  }

  console.log('Access token stale, refreshing...');
  const fresh = await refreshWith(refreshToken);
  return fresh.access_token;
}

// Step 1: Kick off login - visit this URL in your browser to start
app.get('/auth/login', (req, res) => {
  const state = Math.random().toString(36).substring(2); // simple CSRF protection
  const scope = 'user.info.basic,video.publish';

  const authUrl =
    `https://www.tiktok.com/v2/auth/authorize/?client_key=${CLIENT_KEY}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${state}`;

  res.redirect(authUrl);
});

// Step 2: TikTok redirects back here after user approves
app.get('/auth/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(`OAuth error: ${error} - ${error_description}`);
  }
  if (!code) {
    return res.status(400).send('Missing authorization code.');
  }

  try {
    const tokenResponse = await axios.post(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({
        client_key: CLIENT_KEY,
        client_secret: CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const tokens = persistTokens(tokenResponse.data);

    // Show the refresh token once so it can be pasted into Render's env vars.
    // That makes cold starts self-healing instead of needing a fresh login.
    res.send(`
      <h2>Login successful!</h2>
      <p>Access token stored. You can now use the /post endpoint.</p>
      <p><b>Set this as TIKTOK_REFRESH_TOKEN in your Render environment</b> so the
      server survives restarts without you logging in again:</p>
      <pre style="white-space:pre-wrap;word-break:break-all;background:#eee;padding:1em">${tokens.refresh_token}</pre>
    `);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Token exchange failed. Check server logs.');
  }
});

// Helper endpoint to check current stored token status (for your own debugging)
app.get('/auth/status', (req, res) => {
  if (!storedTokens && !process.env.TIKTOK_REFRESH_TOKEN) {
    return res.json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    has_refresh_token: Boolean(storedTokens?.refresh_token || process.env.TIKTOK_REFRESH_TOKEN),
    obtained_at: storedTokens?.obtained_at || null,
  });
});

// Confirms the video the pipeline just pushed is actually being served, so a
// bad deploy shows up here instead of as an opaque TikTok download failure.
app.get('/video-status', (req, res) => {
  const file = path.join(__dirname, 'video', 'video.mp4');
  if (!fs.existsSync(file)) {
    return res.status(404).json({ present: false });
  }
  const stat = fs.statSync(file);
  res.json({ present: true, bytes: stat.size, modified: stat.mtime });
});

// Step 3: Publish a video using the stored access token
// This uses TikTok's "PULL_FROM_URL" method - TikTok fetches the video
// from a public URL you provide (simplest method, no chunked upload needed).
app.post('/post', async (req, res) => {
  const { videoUrl, title } = req.body || {};
  if (!videoUrl) {
    return res.status(400).json({ error: 'videoUrl is required in request body.' });
  }

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') {
      return res.status(401).json({ error: 'Not authenticated. Visit /auth/login first.' });
    }
    console.error(err.response?.data || err.message);
    return res.status(401).json({
      error: 'Token refresh failed — the refresh token is probably expired or revoked.',
      detail: err.response?.data || err.message,
    });
  }

  try {
    const initResponse = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      {
        post_info: {
          title: title || 'Posted via API',
          privacy_level: 'SELF_ONLY', // change to PUBLIC_TO_EVERYONE once app is approved for production
          // The video is an AI voice clone from auto_dub.py, which TikTok's
          // rules require be disclosed as AI-generated content.
          is_aigc: true,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: videoUrl,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json({
      message: 'Video publish initiated.',
      publish_id: initResponse.data?.data?.publish_id,
      data: initResponse.data,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// TikTok downloads the file asynchronously, so init succeeding does not mean
// the post succeeded. This is how you find out which it was.
app.get('/post/status/:publishId', async (req, res) => {
  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  try {
    const resp = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
      { publish_id: req.params.publishId },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
    res.json(resp.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = { getStoredTokens: () => storedTokens };
