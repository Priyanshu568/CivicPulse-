const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const errorMsg = document.getElementById('errorMsg');
const toRegister = document.getElementById('toRegister');
const toLogin = document.getElementById('toLogin');

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.add('show');
}
function clearError() {
  errorMsg.classList.remove('show');
}

toRegister.querySelector('a').addEventListener('click', () => {
  clearError();
  loginForm.style.display = 'none';
  registerForm.style.display = 'block';
  toRegister.style.display = 'none';
  toLogin.style.display = 'block';
});
toLogin.querySelector('a').addEventListener('click', () => {
  clearError();
  registerForm.style.display = 'none';
  loginForm.style.display = 'block';
  toLogin.style.display = 'none';
  toRegister.style.display = 'block';
});

// If already logged in, skip straight to dashboard.
fetch('/api/session').then(r => r.json()).then(data => {
  if (data.user) window.location.href = '/dashboard.html';
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Login failed');
    window.location.href = '/dashboard.html';
  } catch (err) {
    showError('Could not reach the server. Is it running?');
  }
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  const name = document.getElementById('regName').value;
  const email = document.getElementById('regEmail').value;
  const password = document.getElementById('regPassword').value;
  const role = document.getElementById('regRole').value;
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, role })
    });
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Registration failed');
    window.location.href = '/dashboard.html';
  } catch (err) {
    showError('Could not reach the server. Is it running?');
  }
});
