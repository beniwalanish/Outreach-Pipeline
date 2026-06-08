'use strict';

/**
 * Frontend controller — mock-data mode (hiringg.ai-style UI).
 * Simulates the pipeline (Ocean → Prospeo → Enrich → Filter), then renders a
 * verified-contacts table + email preview inside the browser-window mockup.
 *
 * Swap MOCK_MODE -> false and implement fetchContacts() to wire the real API.
 */

const MOCK_MODE = false;

// API base:
//  - Local dev (localhost / 127.0.0.1) -> talk to the backend on :3000.
//  - Production (Render, etc.) -> same-origin ('') since the server serves
//    both the frontend and the API.
//  - Override anytime via window.API_BASE before this script loads.
const API_BASE =
  window.API_BASE != null
    ? window.API_BASE
    : ['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? 'http://localhost:3000'
    : '';

const MOCK_CONTACTS = [
  { fullName: 'Jane Doe', title: 'CEO', companyName: 'Anthropic', companyDomain: 'anthropic.com', email: 'jane@anthropic.com', linkedinUrl: 'https://www.linkedin.com/in/janedoe' },
  { fullName: 'Arjun Mehta', title: 'CTO', companyName: 'Cohere', companyDomain: 'cohere.com', email: 'arjun@cohere.com', linkedinUrl: 'https://www.linkedin.com/in/arjunmehta' },
  { fullName: 'Lena Fischer', title: 'VP Engineering', companyName: 'Perplexity', companyDomain: 'perplexity.ai', email: 'lena@perplexity.ai', linkedinUrl: 'https://www.linkedin.com/in/lenafischer' },
  { fullName: 'Marco Rossi', title: 'Head of Product', companyName: 'Mistral AI', companyDomain: 'mistral.ai', email: 'marco@mistral.ai', linkedinUrl: 'https://www.linkedin.com/in/marcorossi' },
  { fullName: 'Sara Kim', title: 'Director of Growth', companyName: 'Hugging Face', companyDomain: 'huggingface.co', email: 'sara@huggingface.co', linkedinUrl: 'https://www.linkedin.com/in/sarakim' },
];

const form = document.getElementById('lead-form');
const btn = document.getElementById('generate-btn');
const btnLabel = btn.querySelector('.btn-label');
const spinner = btn.querySelector('.spinner');

const progressCard = document.getElementById('progress-card');
const workspace = document.getElementById('workspace');
const resultsBody = document.getElementById('results-body');
const resultCount = document.getElementById('result-count');

const STEP_ORDER = ['ocean', 'prospeo', 'enrich', 'filter'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStep(name, state) {
  const el = document.querySelector(`.step[data-step="${name}"]`);
  if (!el) return;
  el.classList.remove('active', 'done');
  if (state) el.classList.add(state);
  el.querySelector('.step-status').textContent =
    state === 'active' ? 'Running…' : state === 'done' ? 'Done' : 'Pending';
}
function resetSteps() { STEP_ORDER.forEach((s) => setStep(s, null)); }

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function firstNameOf(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }

/** Mirrors backend generateColdEmail(). */
function generateColdEmail(c) {
  const first = escapeHtml(firstNameOf(c.fullName));
  const company = escapeHtml(c.companyName || 'your team');
  const title = escapeHtml(c.title || '');
  const subject = `Quick idea for ${c.companyName || 'your team'}`;
  const roleLine = title
    ? `As ${title} at ${company}, you're likely focused on scaling what works.`
    : `I imagine the team at ${company} is focused on scaling what works.`;
  const htmlContent = `
    <p>Hi ${first},</p>
    <p>${roleLine}</p>
    <p>We help teams like ${company} automate their outbound pipeline end-to-end —
       from finding lookalike accounts to reaching the right decision makers with
       verified contact data.</p>
    <p>Open to a quick 15-minute chat next week?</p>
    <p>Best,<br/>The Outreach Team</p>`;
  return { subject, htmlContent };
}

function renderResults(contacts) {
  resultsBody.innerHTML = '';
  contacts.forEach((c, i) => {
    const tr = document.createElement('tr');
    tr.dataset.index = i;
    tr.innerHTML = `
      <td>${escapeHtml(c.fullName)}</td>
      <td>${escapeHtml(c.title)}</td>
      <td>${escapeHtml(c.companyName)}</td>
      <td class="email-cell">${escapeHtml(c.email)}</td>
      <td>${
        c.linkedinUrl
          ? `<a class="in-link" href="${escapeHtml(c.linkedinUrl)}" target="_blank" rel="noopener" title="LinkedIn">in</a>`
          : '—'
      }</td>`;
    tr.addEventListener('click', () => selectContact(i, contacts));
    resultsBody.appendChild(tr);
  });
  resultCount.textContent = String(contacts.length);
}

function selectContact(index, contacts) {
  document.querySelectorAll('#results-body tr')
    .forEach((tr) => tr.classList.toggle('selected', Number(tr.dataset.index) === index));
  const c = contacts[index];
  const { subject, htmlContent } = generateColdEmail(c);
  document.getElementById('preview-to').textContent = `${c.fullName} <${c.email}>`;
  document.getElementById('preview-subject').textContent = subject;
  document.getElementById('preview-body').innerHTML = htmlContent;
}

async function fetchContacts(params) {
  if (MOCK_MODE) {
    await sleep(300);
    return MOCK_CONTACTS.slice(0, Math.max(1, params.maxSimilar));
  }
  const res = await fetch(`${API_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Backend error ${res.status}`);
  return Array.isArray(data.contacts) ? data.contacts : [];
}

async function runPipeline(params) {
  progressCard.hidden = false;
  workspace.hidden = true;
  resetSteps();

  // Kick off the real request immediately; animate steps alongside it.
  const dataPromise = fetchContacts(params);

  for (let i = 0; i < STEP_ORDER.length; i += 1) {
    const step = STEP_ORDER[i];
    setStep(step, 'active');
    // Hold the final step "active" until the backend actually responds.
    if (i < STEP_ORDER.length - 1) {
      await sleep(700);
      setStep(step, 'done');
    }
  }

  let contacts;
  try {
    contacts = await dataPromise;
  } finally {
    setStep(STEP_ORDER[STEP_ORDER.length - 1], 'done');
  }

  renderResults(contacts);
  workspace.hidden = false;
  if (contacts.length) selectContact(0, contacts);
  workspace.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setLoading(loading) {
  btn.disabled = loading;
  spinner.hidden = !loading;
  btnLabel.textContent = loading ? 'Working…' : 'Generate';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const params = {
    domain: document.getElementById('domain').value.trim(),
    maxSimilar: parseInt(document.getElementById('max-similar').value, 10) || 5,
    maxPeople: parseInt(document.getElementById('max-people').value, 10) || 10,
  };
  if (!params.domain) { document.getElementById('domain').focus(); return; }
  setLoading(true);
  try {
    await runPipeline(params);
  } catch (err) {
    alert(`Pipeline failed: ${err.message}`);
  } finally {
    setLoading(false);
  }
});

// ---------- Browser-bar icon actions ----------

const MOCK_URL = 'https://app.outreachpipeline.ai/generate';

function flash(btn) {
  btn.style.color = 'var(--ok)';
  setTimeout(() => { btn.style.color = ''; }, 900);
}

document.getElementById('copy-url').addEventListener('click', async (e) => {
  try {
    await navigator.clipboard.writeText(MOCK_URL);
    flash(e.currentTarget);
  } catch { alert('Copy failed'); }
});

document.getElementById('share-url').addEventListener('click', async (e) => {
  if (navigator.share) {
    try { await navigator.share({ title: 'OutreachPipeline', url: MOCK_URL }); } catch {}
  } else {
    try { await navigator.clipboard.writeText(MOCK_URL); flash(e.currentTarget); } catch {}
  }
});

document.getElementById('open-tab').addEventListener('click', () => {
  window.open(MOCK_URL, '_blank', 'noopener');
});

// Back / forward — cosmetic browser-chrome feedback (mock).
const navBack = document.getElementById('nav-back');
const navForward = document.getElementById('nav-forward');
navForward.disabled = true; // nothing forward yet, like a fresh tab
[navBack, navForward].forEach((b) =>
  b.addEventListener('click', () => {
    if (b.disabled) return;
    b.animate(
      [{ transform: 'scale(0.85)' }, { transform: 'scale(1)' }],
      { duration: 180, easing: 'ease-out' }
    );
  })
);
