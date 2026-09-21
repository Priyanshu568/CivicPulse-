let currentUser = null;
let allContractors = [];
let leafletMap = null;
let mapMarkersLayer = null;

// ---------- auth guard ----------
async function init() {
  const sessionRes = await fetch('/api/session');
  const sessionData = await sessionRes.json();
  if (!sessionData.user) { window.location.href = '/index.html'; return; }
  currentUser = sessionData.user;
  document.getElementById('userName').textContent = currentUser.name;
  document.getElementById('userRole').textContent = currentUser.role;

  const contractorsRes = await fetch('/api/contractors');
  allContractors = await contractorsRes.json();

  // Reveal the bits of UI this role is allowed to see.
  if (currentUser.role === 'admin') {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('admin-only'));
  }
  if (currentUser.role === 'admin' || currentUser.role === 'department') {
    document.querySelectorAll('.staff-only').forEach(el => el.classList.remove('staff-only'));
    loadFeedback();
  }
  if (currentUser.role === 'admin') {
    loadFinance();
  }

  loadReports();
}
init();

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/index.html';
});

// ---------- tabs ----------
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'map') setTimeout(initMap, 50);
  });
});

// ---------- location method 1: live GPS ----------
async function reverseGeocode(lat, lon) {
  const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&addressdetails=1&zoom=18`);
  const data = await res.json();
  return data && data.address ? data : null;
}

document.getElementById('useLocationBtn').addEventListener('click', () => {
  const status = document.getElementById('lookupStatus');
  const details = document.getElementById('pincodeDetails');
  details.textContent = '';
  if (!navigator.geolocation) return alert('Geolocation not supported by this browser.');
  status.textContent = 'Getting your location…';
  navigator.geolocation.getCurrentPosition(
    async pos => {
      const lat = pos.coords.latitude.toFixed(6);
      const lng = pos.coords.longitude.toFixed(6);
      document.getElementById('lat').value = lat;
      document.getElementById('lng').value = lng;
      status.textContent = 'Location set from GPS. Looking up address…';

      try {
        const result = await reverseGeocode(lat, lng);
        if (result) {
          const a = result.address;
          const locality = a.suburb || a.neighbourhood || a.village || a.town || a.city_district || '';
          const city = a.city || a.town || a.county || '';
          const state = a.state || '';
          const pin = a.postcode || '';
          const road = a.road || '';

          // Fill the address fields so they match what GPS found, without
          // overwriting anything the person already typed themselves.
          const streetField = document.getElementById('street');
          const addressField = document.getElementById('address');
          const cityField = document.getElementById('city');
          const stateField = document.getElementById('state');
          const pincodeField = document.getElementById('pincode');
          if (!streetField.value && road) streetField.value = road;
          if (!addressField.value) addressField.value = locality;
          if (!cityField.value && city) cityField.value = city;
          if (!stateField.value && state) stateField.value = state;
          if (!pincodeField.value && pin) pincodeField.value = pin;

          status.textContent = 'Location set from GPS.';
          details.textContent = `Area: ${locality || city || 'Unknown'} · State: ${state || 'Unknown'} · PIN: ${pin || 'Not found'}`;
        } else {
          status.textContent = 'Location set from GPS.';
          details.textContent = 'Could not resolve an address for these coordinates, but they are still accurate to use.';
        }
      } catch (err) {
        status.textContent = 'Location set from GPS.';
        details.textContent = 'Address lookup for this GPS point failed (coordinates are still saved correctly).';
      }
    },
    () => {
      status.textContent = '';
      alert('Could not fetch your location. Your browser may have blocked location access, or you can use the address / PIN code option below instead.');
    }
  );
});

// ---------- location method 2: address / pincode (for citizens without live GPS) ----------
// Resolves ANY of India's ~19,000+ PIN codes using India Post's own official
// Pincode API (the authoritative government source — not a static file we
// maintain ourselves), then geocodes the confirmed Post Office / District /
// State into coordinates. This is far more reliable nationwide than trying
// to match a free-text address alone.

async function lookupIndiaPostPincode(pincode) {
  const res = await fetch('https://api.postalpincode.in/pincode/' + pincode);
  const data = await res.json();
  if (!Array.isArray(data) || !data.length || data[0].Status !== 'Success' || !data[0].PostOffice || !data[0].PostOffice.length) {
    return null;
  }
  // Prefer a Post Office name that matches what the person typed as their
  // address/locality, if they gave one; otherwise use the first result.
  return data[0].PostOffice;
}

async function tryGeocode(query) {
  const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=' + encodeURIComponent(query));
  const results = await res.json();
  return results.length ? results[0] : null;
}

document.getElementById('lookupAddressBtn').addEventListener('click', async () => {
  const status = document.getElementById('lookupStatus');
  const details = document.getElementById('pincodeDetails');
  const houseNo = document.getElementById('houseNo').value.trim();
  const street = document.getElementById('street').value.trim();
  const landmark = document.getElementById('landmark').value.trim();
  const address = document.getElementById('address').value.trim();
  const city = document.getElementById('city').value.trim();
  const state = document.getElementById('state').value.trim();
  const pincode = document.getElementById('pincode').value.trim();
  details.textContent = '';

  if (!address && !pincode && !street) {
    status.textContent = '';
    return alert('Fill in at least the Area/Locality or PIN code before confirming.');
  }
  if (pincode && !/^\d{6}$/.test(pincode)) {
    return alert('Indian PIN codes are 6 digits, e.g. 700091.');
  }

  status.textContent = 'Searching…';
  try {
    let postOffices = null;
    if (pincode) {
      postOffices = await lookupIndiaPostPincode(pincode);
      if (!postOffices) {
        status.textContent = '';
        return alert('That PIN code was not found in India Post\'s records. Double-check the 6 digits.');
      }
      const match = address
        ? postOffices.find(po => po.Name.toLowerCase().includes(address.toLowerCase()) || address.toLowerCase().includes(po.Name.toLowerCase()))
        : null;
      const po = match || postOffices[0];
      details.textContent = `Post Office: ${po.Name} · District: ${po.District} · State: ${po.State}`;
      // Auto-fill city/state if the person left them blank.
      const cityField = document.getElementById('city');
      const stateField = document.getElementById('state');
      if (!cityField.value) cityField.value = po.District;
      if (!stateField.value) stateField.value = po.State;
    }

    // Build geocoding attempts from most specific (full street address) to
    // least (just district/state), so a detailed entry still falls back
    // gracefully instead of failing outright.
    const fullLine = [houseNo, street, landmark, address, city, state].filter(Boolean).join(', ');
    const attempts = [];
    if (fullLine) attempts.push(`${fullLine}, India`);
    if (postOffices) {
      const po = postOffices[0];
      attempts.push(`${address || po.Name}, ${po.District}, ${po.State}, India`);
      attempts.push(`${po.District}, ${po.State}, India`);
    } else if (address || city || state) {
      attempts.push(`${[address, city, state].filter(Boolean).join(', ')}, India`);
    }

    let found = null;
    for (const query of attempts) {
      found = await tryGeocode(query);
      if (found) break;
      await new Promise(r => setTimeout(r, 400)); // be polite between retries
    }
    if (!found) {
      status.textContent = '';
      return alert('Address confirmed, but exact map coordinates could not be pinned down automatically. You can still submit — the department will locate it from the written address.');
    }
    document.getElementById('lat').value = parseFloat(found.lat).toFixed(6);
    document.getElementById('lng').value = parseFloat(found.lon).toFixed(6);
    status.textContent = 'Address confirmed and located on the map.';
  } catch (err) {
    status.textContent = '';
    alert('Lookup failed. Check your internet connection and try again.');
  }
});

function buildFullAddress() {
  const houseNo = document.getElementById('houseNo').value.trim();
  const street = document.getElementById('street').value.trim();
  const landmark = document.getElementById('landmark').value.trim();
  const address = document.getElementById('address').value.trim();
  const city = document.getElementById('city').value.trim();
  const state = document.getElementById('state').value.trim();
  const pincode = document.getElementById('pincode').value.trim();
  const parts = [houseNo, street, landmark ? `(near ${landmark})` : '', address, city, state, pincode].filter(Boolean);
  return parts.join(', ');
}

// ---------- voice-note recorder (reused by report form + feedback form) ----------
function setupAudioRecorder(containerId) {
  const container = document.getElementById(containerId);
  const recordBtn = container.querySelector('[data-action="record"]');
  const stopBtn = container.querySelector('[data-action="stop"]');
  const clearBtn = container.querySelector('[data-action="clear"]');
  const indicator = container.querySelector('.recording-indicator');
  const audioEl = container.querySelector('audio');
  let mediaRecorder = null;
  let chunks = [];
  let blob = null;

  recordBtn.addEventListener('click', async () => {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      return alert('Voice recording is not supported in this browser.');
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      mediaRecorder.onstop = () => {
        blob = new Blob(chunks, { type: 'audio/webm' });
        audioEl.src = URL.createObjectURL(blob);
        audioEl.style.display = 'block';
        clearBtn.style.display = 'inline-block';
        stream.getTracks().forEach(t => t.stop());
      };
      mediaRecorder.start();
      recordBtn.style.display = 'none';
      stopBtn.style.display = 'inline-block';
      indicator.style.display = 'inline';
      audioEl.style.display = 'none';
      clearBtn.style.display = 'none';
    } catch (err) {
      alert('Could not access the microphone. Check your browser\'s microphone permissions for this site.');
    }
  });

  stopBtn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    stopBtn.style.display = 'none';
    recordBtn.style.display = 'inline-block';
    indicator.style.display = 'none';
  });

  clearBtn.addEventListener('click', () => {
    blob = null;
    audioEl.removeAttribute('src');
    audioEl.style.display = 'none';
    clearBtn.style.display = 'none';
  });

  return {
    getBlob: () => blob,
    reset: () => {
      blob = null;
      chunks = [];
      audioEl.removeAttribute('src');
      audioEl.style.display = 'none';
      clearBtn.style.display = 'none';
    }
  };
}

const reportAudioRecorder = setupAudioRecorder('reportRecorder');
const feedbackAudioRecorder = setupAudioRecorder('feedbackRecorder');

// ---------- submit report ----------
document.getElementById('reportForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const mobile = document.getElementById('mobile').value.trim();
  if (!/^\d{10}$/.test(mobile)) {
    return alert('Enter a valid 10-digit mobile number.');
  }
  const fullAddress = buildFullAddress();
  if (!fullAddress) {
    return alert('Fill in at least an area/locality or PIN code so the department can find this issue.');
  }
  let lat = document.getElementById('lat').value;
  let lng = document.getElementById('lng').value;
  if (!lat || !lng) {
    // No coordinates resolved yet — try one last time from the typed address before giving up.
    document.getElementById('lookupStatus').textContent = 'Resolving map location before submitting…';
    document.getElementById('lookupAddressBtn').click();
    return alert('Click "Submit Report" again in a moment — we\'re still pinning your address on the map.');
  }

  const fd = new FormData();
  fd.append('category', document.getElementById('category').value);
  fd.append('description', document.getElementById('description').value);
  fd.append('lat', lat);
  fd.append('lng', lng);
  fd.append('mobile', mobile);
  fd.append('fullAddress', fullAddress);
  const photoFile = document.getElementById('photo').files[0];
  if (photoFile) fd.append('photo', photoFile);
  const reportAudioBlob = reportAudioRecorder.getBlob();
  if (reportAudioBlob) fd.append('audio', reportAudioBlob, 'voice-note.webm');

  const res = await fetch('/api/reports', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Could not submit report');

  document.getElementById('reportForm').reset();
  document.getElementById('lookupStatus').textContent = '';
  document.getElementById('pincodeDetails').textContent = '';
  reportAudioRecorder.reset();
  alert(`Report submitted!\nCategory: ${data.category}\nSeverity: ${data.severity}\nRouted to: ${data.department}`);
  loadReports();
});

// ---------- status board ----------
async function loadReports() {
  const res = await fetch('/api/reports');
  const reports = await res.json();
  renderReportList(reports);
  if (leafletMap) renderMapMarkers(reports);
}

function severityBadgeClass(sev) {
  return sev === 'High' ? 'badge-high' : sev === 'Low' ? 'badge-low' : 'badge-medium';
}

function renderReportList(reports) {
  const container = document.getElementById('reportList');
  if (!reports.length) {
    container.innerHTML = '<div class="empty-state">No reports yet. Submit one from the "Report an Issue" tab.</div>';
    return;
  }
  const canManage = currentUser.role === 'department' || currentUser.role === 'admin';

  container.innerHTML = reports.map(r => {
    const contractorHtml = r.contractor ? `
      <div class="contractor-box">
        <h4>Assigned Contractor</h4>
        <div class="contractor-name">${escapeHtml(r.contractor.name)}</div>
        <div class="contractor-meta">${escapeHtml(r.contractor.company || '')}</div>
        <div class="contractor-meta">✉ ${escapeHtml(r.contractor.email)}${r.contractor.phone ? ' · ' + escapeHtml(r.contractor.phone) : ''}</div>
        ${r.contractor.previousProjects && r.contractor.previousProjects.length ? `
          <div class="contractor-meta" style="margin-top:6px; font-weight:600;">Previous projects</div>
          <ul class="projects-list">
            ${r.contractor.previousProjects.map(p => `<li><strong>${escapeHtml(p.name)}</strong>${p.year ? ' (' + p.year + ')' : ''} — ${escapeHtml(p.description || '')}</li>`).join('')}
          </ul>` : ''}
      </div>
    ` : `<div class="contractor-box"><h4>Assigned Contractor</h4><div class="no-contractor">Not yet assigned.</div></div>`;

    const assignHtml = canManage ? `
      <div class="assign-row">
        <select id="assign-${r.id}">
          <option value="">Assign a contractor…</option>
          ${allContractors.map(c => `<option value="${c.id}" ${r.contractorId === c.id ? 'selected' : ''}>${escapeHtml(c.name)} (${escapeHtml((c.specialties||[]).join(', '))})</option>`).join('')}
        </select>
        <button class="btn btn-secondary btn-small" onclick="assignContractor('${r.id}')">Assign</button>
      </div>
    ` : '';

    const statusOptions = ['Submitted', 'Acknowledged', 'In Progress', 'Resolved'];
    const statusControls = canManage ? `
      <div class="status-controls">
        ${statusOptions.map(s => `<button class="${r.status === s ? 'current' : ''}" onclick="setStatus('${r.id}','${s}')">${s}</button>`).join('')}
      </div>
    ` : '';

    return `
      <div class="report-card">
        <div class="report-top">
          <div>
            <strong>${escapeHtml(r.category)}</strong>
            <span class="badge ${severityBadgeClass(r.severity)}">${r.severity}</span>
          </div>
          <span class="status-pill status-${r.status.replace(' ', '')}">${r.status}</span>
        </div>
        ${r.photoPath ? `<img class="report-photo" src="${r.photoPath}" alt="Reported issue photo">` : ''}
        <div>${escapeHtml(r.description || 'No description provided.')}</div>
        ${r.audioPath ? `<audio controls src="${r.audioPath}" style="width:100%; margin-top:8px;"></audio>` : ''}
        <div class="meta-row">Routed to: <strong>${escapeHtml(r.department)}</strong> · Reported ${new Date(r.createdAt).toLocaleString()}</div>
        ${r.fullAddress ? `<div class="meta-row">📍 ${escapeHtml(r.fullAddress)}</div>` : ''}
        ${r.mobile ? `<div class="meta-row">📞 ${escapeHtml(r.mobile)}</div>` : ''}
        ${r.duplicateOf && r.duplicateOf.length ? `<div class="dup-flag">⚠ Possible duplicate of ${r.duplicateOf.length} nearby report(s)</div>` : ''}
        ${contractorHtml}
        ${assignHtml}
        ${statusControls}
      </div>
    `;
  }).join('');
}

async function assignContractor(reportId) {
  const select = document.getElementById('assign-' + reportId);
  const contractorId = select.value;
  if (!contractorId) return;
  const res = await fetch(`/api/reports/${reportId}/assign-contractor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contractorId })
  });
  if (!res.ok) { const d = await res.json(); return alert(d.error || 'Could not assign contractor'); }
  loadReports();
}

async function setStatus(reportId, status) {
  const res = await fetch(`/api/reports/${reportId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  if (!res.ok) { const d = await res.json(); return alert(d.error || 'Could not update status'); }
  loadReports();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- map ----------
// This is a hyperlocal civic-issue map, so it should never need to zoom out
// past city level. Capping minZoom (and setting maxBounds around the city)
// keeps it there — which also means it never renders country-level borders,
// so it can't show international boundaries incorrectly (e.g. the disputed
// dashed line the default OSM tiles draw through Jammu & Kashmir instead of
// India's full territory). Swap CITY_CENTER / CITY_BOUNDS for whichever city
// a given deployment actually serves.
const CITY_CENTER = [22.5726, 88.3639]; // Kolkata
const CITY_BOUNDS = [
  [22.30, 88.10], // SW corner, roughly Kolkata metro area
  [22.75, 88.55]  // NE corner
];

function initMap() {
  if (leafletMap) { leafletMap.invalidateSize(); return; }
  leafletMap = L.map('map', {
    minZoom: 11,   // can't zoom out far enough to reach country-level rendering
    maxZoom: 19,
    maxBounds: CITY_BOUNDS,
    maxBoundsViscosity: 1.0 // hard-stops panning at the edge instead of rubber-banding
  }).setView(CITY_CENTER, 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(leafletMap);
  mapMarkersLayer = L.layerGroup().addTo(leafletMap);
  fetch('/api/reports').then(r => r.json()).then(renderMapMarkers);
}

function renderMapMarkers(reports) {
  if (!mapMarkersLayer) return;
  mapMarkersLayer.clearLayers();
  reports.forEach(r => {
    const color = r.severity === 'High' ? '#c0392b' : r.severity === 'Low' ? '#4caf7d' : '#e8963c';
    const marker = L.circleMarker([r.lat, r.lng], {
      radius: 9, color, fillColor: color, fillOpacity: 0.75, weight: 1
    });
    marker.bindPopup(`
      <strong>${escapeHtml(r.category)}</strong> (${r.severity})<br>
      Status: ${r.status}<br>
      ${r.duplicateOf && r.duplicateOf.length ? '⚠ Possible duplicate<br>' : ''}
      ${escapeHtml(r.description || '')}
    `);
    marker.addTo(mapMarkersLayer);
  });
}

// ---------- feedback ----------
document.querySelectorAll('#starRating span').forEach(star => {
  star.addEventListener('click', () => {
    const val = star.dataset.value;
    document.getElementById('feedbackRating').value = val;
    document.querySelectorAll('#starRating span').forEach(s => {
      s.classList.toggle('selected', Number(s.dataset.value) <= Number(val));
    });
  });
});

document.getElementById('feedbackForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const rating = document.getElementById('feedbackRating').value;
  const message = document.getElementById('feedbackMessage').value.trim();
  const audioBlob = feedbackAudioRecorder.getBlob();
  if (!message && !audioBlob) {
    return alert('Write a message or record a voice note before submitting.');
  }

  const fd = new FormData();
  if (rating) fd.append('rating', rating);
  fd.append('message', message);
  if (audioBlob) fd.append('audio', audioBlob, 'feedback-voice-note.webm');

  const res = await fetch('/api/feedback', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Could not submit feedback');

  document.getElementById('feedbackForm').reset();
  document.getElementById('feedbackRating').value = '';
  document.querySelectorAll('#starRating span').forEach(s => s.classList.remove('selected'));
  feedbackAudioRecorder.reset();
  alert('Thanks for the feedback!');
  if (currentUser.role === 'admin' || currentUser.role === 'department') loadFeedback();
});

async function loadFeedback() {
  const res = await fetch('/api/feedback');
  if (!res.ok) return; // citizen accounts get 403 here — nothing to show them
  const feedback = await res.json();
  renderFeedbackList(feedback);
}

function renderFeedbackList(items) {
  const container = document.getElementById('feedbackList');
  if (!items.length) {
    container.innerHTML = '<div class="empty-state">No feedback yet.</div>';
    return;
  }
  container.innerHTML = items.map(f => `
    <div class="report-card">
      <div class="report-top">
        <strong>${escapeHtml(f.userName)}</strong>
        ${f.rating ? `<span class="badge badge-medium">${'★'.repeat(f.rating)}${'☆'.repeat(5 - f.rating)}</span>` : ''}
      </div>
      ${f.message ? `<div>${escapeHtml(f.message)}</div>` : ''}
      ${f.audioPath ? `<audio controls src="${f.audioPath}" style="width:100%; margin-top:8px;"></audio>` : ''}
      <div class="meta-row">${new Date(f.createdAt).toLocaleString()}</div>
    </div>
  `).join('');
}

// ---------- contractor finance (admin only) ----------
async function loadFinance() {
  const res = await fetch('/api/contractors');
  if (!res.ok) return; // non-admin accounts never get finance fields back anyway
  const contractors = await res.json();
  renderFinanceList(contractors);
}

function renderFinanceList(contractors) {
  const container = document.getElementById('financeList');
  if (!contractors.length) {
    container.innerHTML = '<div class="card"><div class="empty-state">No contractors yet.</div></div>';
    return;
  }
  container.innerHTML = contractors.map(c => `
    <div class="card">
      <h2 style="font-size:1rem;">${escapeHtml(c.name)} <span class="hint">${escapeHtml(c.company || '')}</span></h2>
      <div class="grid-2">
        <div class="field">
          <label>Contract amount (₹)</label>
          <input type="number" min="0" id="ca-${c.id}" value="${c.contractAmount ?? 0}">
        </div>
        <div class="field">
          <label>Amount claimed (₹)</label>
          <input type="number" min="0" id="acl-${c.id}" value="${c.amountClaimed ?? 0}">
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label>Amount paid (₹)</label>
          <input type="number" min="0" id="ap-${c.id}" value="${c.amountPaid ?? 0}">
        </div>
        <div class="field">
          <label>Contract period</label>
          <div style="display:flex; gap:8px;">
            <input type="date" id="cs-${c.id}" value="${c.contractStartDate || ''}">
            <input type="date" id="ce-${c.id}" value="${c.contractEndDate || ''}">
          </div>
        </div>
      </div>
      <div class="field">
        <label>Contract terms / notes</label>
        <textarea id="ct-${c.id}" rows="2">${escapeHtml(c.contractTerms || '')}</textarea>
      </div>
      <button class="btn btn-secondary btn-small" onclick="saveFinance('${c.id}')">Save</button>
    </div>
  `).join('');
}

async function saveFinance(contractorId) {
  const body = {
    contractAmount: document.getElementById('ca-' + contractorId).value,
    amountClaimed: document.getElementById('acl-' + contractorId).value,
    amountPaid: document.getElementById('ap-' + contractorId).value,
    contractStartDate: document.getElementById('cs-' + contractorId).value,
    contractEndDate: document.getElementById('ce-' + contractorId).value,
    contractTerms: document.getElementById('ct-' + contractorId).value
  };
  const res = await fetch(`/api/contractors/${contractorId}/finance`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) { const d = await res.json(); return alert(d.error || 'Could not save'); }
  alert('Saved.');
  loadFinance();
}