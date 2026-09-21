// One-time helper: sets known, working passwords for demo accounts.
// Run this AFTER `npm install` (it needs bcryptjs from node_modules):
//
//   node reset-demo-users.js
//
// Safe to run multiple times — it just overwrites the listed accounts'
// passwords each time, so you can always get back to a known-good state
// right before you walk on stage.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'db.json');

const DEMO_USERS = [
  { name: 'Priyanshu Bhatta',  email: 'priyanshubhatta2007@gmail.com', password: 'Citizen@123',   role: 'citizen' },
  { name: 'Demo Citizen',      email: 'citizen@civicpulse.gov.in',      password: 'Citizen@123',   role: 'citizen' },
  { name: 'Demo Department',   email: 'department@civicpulse.gov.in',  password: 'Dept@123',      role: 'department' },
  { name: 'Demo Admin',        email: 'admin@civicpulse.gov.in',        password: 'Admin@123',     role: 'admin' }
];

function newId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 12);
}

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
db.users = db.users || [];

for (const demo of DEMO_USERS) {
  const hash = bcrypt.hashSync(demo.password, 10);
  const existing = db.users.find(u => u.email.toLowerCase() === demo.email.toLowerCase());
  if (existing) {
    existing.passwordHash = hash;
    existing.role = demo.role;
    existing.name = demo.name;
  } else {
    db.users.push({
      id: newId('u'),
      name: demo.name,
      email: demo.email,
      passwordHash: hash,
      role: demo.role,
      createdAt: new Date().toISOString()
    });
  }
}

fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

console.log('Demo accounts are ready. Log in with any of these:\n');
DEMO_USERS.forEach(u => {
  console.log(`  role: ${u.role.padEnd(10)} email: ${u.email.padEnd(35)} password: ${u.password}`);
});
console.log('\nRun this script again any time to reset them back to these passwords.');
