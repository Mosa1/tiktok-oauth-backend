require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI; // must match EXACTLY what's registered in TikTok portal

// In-memory token storage for now (single-user personal use).
// For anything beyond personal/single-user, swap this for a real database.
let storedTokens = null;

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

    storedTokens = tokenResponse.data; // contains access_token, refresh_token, expires_in, etc.

    res.send(`
      <h2>Login successful!</h2>
      <p>Access token stored. You can close this tab and use the /post endpoint to publish videos.</p>
    `);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Token exchange failed. Check server logs.');
  }
});

// Helper endpoint to check current stored token status (for your own debugging)
app.get('/auth/status', (req, res) => {
  if (!storedTokens) return res.json({ authenticated: false });
  res.json({ authenticated: true, expires_in: storedTokens.expires_in });
});

// Step 3: Publish a video using the stored access token
// This uses TikTok's "PULL_FROM_URL" method - TikTok fetches the video
// from a public URL you provide (simplest method, no chunked upload needed).
app.post('/post', async (req, res) => {
  if (!storedTokens) {
    return res.status(401).json({ error: 'Not authenticated. Visit /auth/login first.' });
  }

  const { videoUrl, title } = req.body;
  if (!videoUrl) {
    return res.status(400).json({ error: 'videoUrl is required in request body.' });
  }

  try {
    // Init the post
    const initResponse = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      {
        post_info: {
          title: title || 'Posted via API',
          privacy_level: 'SELF_ONLY', // change to PUBLIC_TO_EVERYONE once app is approved for production
        },
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: videoUrl,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${storedTokens.access_token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json({
      message: 'Video publish initiated.',
      data: initResponse.data,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = { getStoredTokens: () => storedTokens };
