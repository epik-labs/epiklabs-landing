const SPREADSHEET_ID = '1YMX3M7ay1uPARig12FmhchXyHrhVsvWVYrDo1X3HkZI';
const SHEET_RANGE = 'Sheet1!A:B';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, request);
    }

    let email;
    const contentType = request.headers.get('content-type') || '';

    try {
      if (contentType.includes('application/json')) {
        const body = await request.json();
        email = body.email;
      } else {
        const formData = await request.formData();
        email = formData.get('email');
      }
    } catch {
      return json({ error: 'Invalid request body' }, 400, request);
    }

    if (!email || !isValidEmail(email)) {
      return json({ error: 'Valid email required' }, 400, request);
    }

    const timestamp = new Date().toISOString();
    const errors = [];

    try {
      await appendToSheet(env, email, timestamp);
    } catch (err) {
      console.error('Sheet error:', err.message);
      errors.push('sheet');
    }

    try {
      await notifySlack(env, email, timestamp);
    } catch (err) {
      console.error('Slack error:', err.message);
      errors.push('slack');
    }

    // Only fail if both integrations failed
    if (errors.length === 2) {
      return json({ error: 'Failed to record submission. Please try again.' }, 500, request);
    }

    return json({ success: true }, 200, request);
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}

function corsHeaders(request) {
  const origin = request ? request.headers.get('Origin') : null;
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

// ── Google Sheets ─────────────────────────────────────────────────────────────

async function appendToSheet(env, email, timestamp) {
  const accessToken = await getGoogleAccessToken(env);

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}` +
    `/values/${encodeURIComponent(SHEET_RANGE)}:append?valueInputOption=USER_ENTERED`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: [[email, timestamp]] }),
  });

  if (!res.ok) {
    throw new Error(`Sheets API ${res.status}: ${await res.text()}`);
  }
}

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const jwt = await signJWT(claimSet, env.GOOGLE_PRIVATE_KEY);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    throw new Error(`Google OAuth ${res.status}: ${await res.text()}`);
  }

  const { access_token } = await res.json();
  return access_token;
}

async function signJWT(payload, privateKeyPem) {
  const b64url = (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

  const encode = (obj) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const body = encode(payload);
  const signingInput = `${header}.${body}`;

  // Strip PEM armor and decode
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const keyBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${b64url(sig)}`;
}

// ── Slack ─────────────────────────────────────────────────────────────────────

async function notifySlack(env, email, timestamp) {
  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:tada: *New waitlist signup*\n*Email:* ${email}\n*Time:* ${timestamp}`,
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook ${res.status}`);
  }
}
