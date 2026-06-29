const db = require('../db');

async function sendMailgunEmail({ to, subject, html }) {
  const configRows = await db.all(`SELECT * FROM app_config`);
  const config = {};
  configRows.forEach(r => {
    config[r.key] = r.value;
  });

  const apiKey = config.mailgun_api_key;
  const domain = config.mailgun_domain;
  const region = config.mailgun_region || 'us';
  const from = config.mailgun_from || `"Dietetyk AI Test" <noreply@${domain || 'dietetyk.ai'}>`;

  if (!apiKey || !domain) {
    throw new Error('Mailgun configuration is missing in app_config database table!');
  }

  const apiBase = region.toLowerCase() === 'eu'
    ? 'https://api.eu.mailgun.net/v3'
    : 'https://api.mailgun.net/v3';

  const url = `${apiBase}/${domain}/messages`;
  
  const formData = new URLSearchParams();
  formData.append('from', from);
  formData.append('to', to);
  formData.append('subject', subject);
  formData.append('html', html);

  const authHeader = `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`;

  console.log(`[TEST-MAILGUN] Sending email to ${to} using domain ${domain}...`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formData.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Mailgun API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log(`[TEST-MAILGUN] Sent successfully. Response ID: ${result.id}`);
  return result;
}

async function runTest() {
  await db.initDb();
  const targetEmail = process.argv[2] || 'mbeczynski@gmail.com';
  console.log(`[TEST-MAILGUN] Starting test mail to: ${targetEmail}`);
  try {
    await sendMailgunEmail({
      to: targetEmail,
      subject: 'Dietetyk AI Mailgun Integration Test',
      html: '<h3>Test Mailgun</h3><p>If you see this, your Mailgun setup on the Dietetyk AI backend is working properly!</p>'
    });
    console.log('[TEST-MAILGUN] Success!');
    process.exit(0);
  } catch (err) {
    console.error('[TEST-MAILGUN] Failed:', err.message);
    process.exit(1);
  }
}

runTest();
