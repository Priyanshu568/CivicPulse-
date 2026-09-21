const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// ---------------------------------------------------------------------------
// Tiny JSON "database" — fine for local/dev use. Not safe for concurrent
// production writes, but this app never runs more than one process locally.
// ---------------------------------------------------------------------------
function readDB() {
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(raw);
}
function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function ensureCollections(db) {
  db.users = db.users || [];
  db.reports = db.reports || [];
  db.feedback = db.feedback || [];
  db.contractors = db.contractors || [];
  return db;
}
function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'civicpulse-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 days
}));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// Multer: store uploaded photos/voice notes on disk with unique names.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || (file.mimetype === 'audio/webm' ? '.webm' : '');
    cb(null, newId('f') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    const okPhoto = file.fieldname === 'photo' && file.mimetype.startsWith('image/');
    const okAudio = file.fieldname === 'audio' && file.mimetype.startsWith('audio/');
    if (okPhoto || okAudio) return cb(null, true);
    cb(new Error('Unsupported file type for field ' + file.fieldname));
  }
});

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    const db = ensureCollections(readDB());
    const user = db.users.find(u => u.id === req.session.userId);
    if (!user || !roles.includes(user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }
    next();
  };
}
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.get('/api/session', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const db = ensureCollections(readDB());
  const user = db.users.find(u => u.id === req.session.userId);
  if (!user) return res.json({ user: null });
  res.json({ user: publicUser(user) });
});

app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const allowedRoles = ['citizen', 'department', 'admin'];
    const finalRole = allowedRoles.includes(role) ? role : 'citizen';

    const db = ensureCollections(readDB());
    const normalizedEmail = String(email).trim().toLowerCase();
    if (db.users.some(u => u.email.toLowerCase() === normalizedEmail)) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
      id: newId('u'),
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash,
      role: finalRole,
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    writeDB(db);
    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const db = ensureCollections(readDB());
    const normalizedEmail = String(email).trim().toLowerCase();
    const user = db.users.find(u => u.email.toLowerCase() === normalizedEmail);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------------------------------------------------------------------------
// Classification helpers (category comes from the form; we derive severity
// and the routed department server-side so the client can't spoof either).
// ---------------------------------------------------------------------------
const DEPARTMENT_BY_CATEGORY = {
  'Pothole': 'Public Works Department',
  'Road Damage': 'Public Works Department',
  'Streetlight': 'Electrical Department',
  'Garbage Overflow': 'Sanitation Department',
  'Water Leakage': 'Water Supply Department',
  'Other': 'General Administration'
};

const HIGH_SEVERITY_WORDS = [
  'accident', 'injur', 'danger', 'urgent', 'emergency', 'collaps', 'fire',
  'electrocut', 'exposed wire', 'live wire', 'sewage', 'flood', 'swerv',
  'deep', 'blocking', 'child', 'school'
];
const LOW_SEVERITY_WORDS = [
  'minor', 'small', 'cosmetic', 'slight', 'flicker'
];

function classifySeverity(description) {
  const text = (description || '').toLowerCase();
  if (HIGH_SEVERITY_WORDS.some(w => text.includes(w))) return 'High';
  if (LOW_SEVERITY_WORDS.some(w => text.includes(w))) return 'Low';
  return 'Medium';
}

function routeDepartment(category) {
  return DEPARTMENT_BY_CATEGORY[category] || 'General Administration';
}

// Haversine distance in meters — used for duplicate detection.
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const DUPLICATE_RADIUS_METERS = 75;

function findDuplicates(db, category, lat, lng, excludeId) {
  return db.reports
    .filter(r => r.id !== excludeId && r.category === category && r.status !== 'Resolved')
    .filter(r => distanceMeters(lat, lng, r.lat, r.lng) <= DUPLICATE_RADIUS_METERS)
    .map(r => r.id);
}

function attachContractor(report, db) {
  if (!report.contractorId) return { ...report, contractor: null };
  const c = db.contractors.find(c => c.id === report.contractorId);
  if (!c) return { ...report, contractor: null };
  // Never leak finance fields through the report/contractor-box view.
  const { contractAmount, amountClaimed, amountPaid, contractStartDate, contractEndDate, contractTerms, ...safe } = c;
  return { ...report, contractor: safe };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
app.get('/api/reports', requireAuth, (req, res) => {
  const db = ensureCollections(readDB());
  const reports = db.reports
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(r => attachContractor(r, db));
  res.json(reports);
});

app.post('/api/reports', requireAuth, upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), (req, res) => {
  try {
    const db = ensureCollections(readDB());
    const user = db.users.find(u => u.id === req.session.userId);
    const { category, description, mobile, fullAddress } = req.body;
    const lat = parseFloat(req.body.lat);
    const lng = parseFloat(req.body.lng);

    if (!category) return res.status(400).json({ error: 'Category is required' });
    if (Number.isNaN(lat) || Number.isNaN(lng)) return res.status(400).json({ error: 'Location is required' });
    if (!mobile || !/^\d{10}$/.test(mobile)) return res.status(400).json({ error: 'A valid 10-digit mobile number is required' });
    if (!fullAddress) return res.status(400).json({ error: 'Address is required' });

    const photoFile = req.files && req.files.photo && req.files.photo[0];
    const audioFile = req.files && req.files.audio && req.files.audio[0];

    const severity = classifySeverity(description);
    const department = routeDepartment(category);

    const report = {
      id: newId('r'),
      userId: user.id,
      userName: user.name,
      category,
      description: description || '',
      severity,
      department,
      status: 'Submitted',
      lat, lng,
      mobile,
      fullAddress,
      photoPath: photoFile ? `/uploads/${photoFile.filename}` : null,
      audioPath: audioFile ? `/uploads/${audioFile.filename}` : null,
      contractorId: null,
      createdAt: new Date().toISOString()
    };
    report.duplicateOf = findDuplicates(db, category, lat, lng, report.id);

    db.reports.push(report);
    writeDB(db);
    res.json(attachContractor(report, db));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not submit report' });
  }
});

app.post('/api/reports/:id/assign-contractor', requireAuth, requireRole('department', 'admin'), (req, res) => {
  const db = ensureCollections(readDB());
  const report = db.reports.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const { contractorId } = req.body;
  const contractor = db.contractors.find(c => c.id === contractorId);
  if (!contractor) return res.status(400).json({ error: 'Contractor not found' });
  report.contractorId = contractorId;
  writeDB(db);
  res.json(attachContractor(report, db));
});

app.patch('/api/reports/:id/status', requireAuth, requireRole('department', 'admin'), (req, res) => {
  const db = ensureCollections(readDB());
  const report = db.reports.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const { status } = req.body;
  const allowed = ['Submitted', 'Acknowledged', 'In Progress', 'Resolved'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  report.status = status;
  writeDB(db);
  res.json(attachContractor(report, db));
});

// ---------------------------------------------------------------------------
// Feedback — citizens can submit; only department/admin can list.
// ---------------------------------------------------------------------------
app.post('/api/feedback', requireAuth, upload.fields([{ name: 'audio', maxCount: 1 }]), (req, res) => {
  try {
    const db = ensureCollections(readDB());
    const user = db.users.find(u => u.id === req.session.userId);
    const { message } = req.body;
    const rating = req.body.rating ? parseInt(req.body.rating, 10) : null;
    const audioFile = req.files && req.files.audio && req.files.audio[0];

    if (!message && !audioFile) {
      return res.status(400).json({ error: 'Write a message or record a voice note before submitting' });
    }

    const entry = {
      id: newId('fb'),
      userId: user.id,
      userName: user.name,
      rating: rating && rating >= 1 && rating <= 5 ? rating : null,
      message: message || '',
      audioPath: audioFile ? `/uploads/${audioFile.filename}` : null,
      createdAt: new Date().toISOString()
    };
    db.feedback.push(entry);
    writeDB(db);
    res.json(entry);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not submit feedback' });
  }
});

app.get('/api/feedback', requireAuth, requireRole('department', 'admin'), (req, res) => {
  const db = ensureCollections(readDB());
  const feedback = db.feedback.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(feedback);
});

// ---------------------------------------------------------------------------
// Contractors — everyone gets the roster (needed for assignment + display),
// but only admins get the finance fields.
// ---------------------------------------------------------------------------
app.get('/api/contractors', requireAuth, (req, res) => {
  const db = ensureCollections(readDB());
  const user = db.users.find(u => u.id === req.session.userId);
  const isAdmin = user && user.role === 'admin';
  const contractors = db.contractors.map(c => {
    if (isAdmin) return c;
    const { contractAmount, amountClaimed, amountPaid, contractStartDate, contractEndDate, contractTerms, ...safe } = c;
    return safe;
  });
  res.json(contractors);
});

app.patch('/api/contractors/:id/finance', requireAuth, requireRole('admin'), (req, res) => {
  const db = ensureCollections(readDB());
  const contractor = db.contractors.find(c => c.id === req.params.id);
  if (!contractor) return res.status(404).json({ error: 'Contractor not found' });
  const { contractAmount, amountClaimed, amountPaid, contractStartDate, contractEndDate, contractTerms } = req.body;
  if (contractAmount !== undefined) contractor.contractAmount = Number(contractAmount) || 0;
  if (amountClaimed !== undefined) contractor.amountClaimed = Number(amountClaimed) || 0;
  if (amountPaid !== undefined) contractor.amountPaid = Number(amountPaid) || 0;
  if (contractStartDate !== undefined) contractor.contractStartDate = contractStartDate;
  if (contractEndDate !== undefined) contractor.contractEndDate = contractEndDate;
  if (contractTerms !== undefined) contractor.contractTerms = contractTerms;
  writeDB(db);
  res.json(contractor);
});

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err) {
    console.error(err);
    return res.status(400).json({ error: err.message || 'Upload error' });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`CivicPulse server running at http://localhost:${PORT}`);
});
