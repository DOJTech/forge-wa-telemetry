'use strict';

// Full address of the scoring endpoint on the API service
const API_URL = 'https://forge-telemetry-api.onrender.com/api/v1/dispute/score';

const $ = q => document.querySelector(q);
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pill = text => `<span class="pill">${esc(text)}</span>`;
const showError = (title, msg) =>
  ($('#out').innerHTML = `<strong>${esc(title)}</strong><ul class="err"><li>${esc(msg)}</li></ul>`);

const SAMPLE_PAYLOAD = {
  case_id: 'WA-DISP-2026-88401',
  bank_code: '011',
  telemetry_version: 'schema_wa_v1',
  transaction_details: {
    transaction_id: 'TXN-99824102941',
    amount: 750000.0,
    currency: 'NGN',
    channel: 'POS',
    merchant_id: 'MCH-IKOYI-04',
    is_chargeback_valid: true,
    dispute_reason: 'duplicate_debit',
    timestamp: '2026-10-07T09:45:00Z'
  },
  compliance_meta: {
    country_code: 'NG',
    routing_verification: 'PENDING'
  }
};

$('#ta').value = JSON.stringify(SAMPLE_PAYLOAD, null, 2);

$('#run').addEventListener('click', async () => {
  const btn = $('#run');
  let data;
  try {
    data = JSON.parse($('#ta').value);
  } catch (e) {
    showError('Invalid JSON Format', e.message);
    return;
  }

  btn.disabled = true;
  $('#out').innerHTML =
    '<span class="mut">Processing... (the first request can take up to a minute if the server is waking up)</span>';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75000);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: controller.signal
    });
    const result = await response.json().catch(() => ({}));

    if (response.ok && result.success) {
      const r = result.data;
      $('#out').innerHTML = `
        <div class="score">${Number(r.riskScore).toFixed(2)}</div>
        <div>${pill(r.decision)}</div>
        ${r.logged ? '<div class="ok">✔ Result saved to the audit log.</div>' : ''}
      `;
    } else {
      showError(
        response.status === 400 ? 'Schema Rejection' : 'Request Failed',
        result.error || `Server responded with status ${response.status}.`
      );
    }
  } catch (err) {
    console.error('Communication fault:', err);
    showError(
      'System Connection Error',
      err.name === 'AbortError'
        ? 'The server took too long to respond. Try again in a moment.'
        : 'Could not reach the API. Check that it is running and that CORS allows this site.'
    );
  } finally {
    clearTimeout(timer);
    btn.disabled = false;
  }
});
