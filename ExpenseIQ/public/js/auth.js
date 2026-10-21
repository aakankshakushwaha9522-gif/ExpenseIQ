/**
 * auth.js — hand-written login / registration / logout.
 * Talks to our own server (/api/auth/*). The server hashes passwords with scrypt and keeps
 * the login in an HttpOnly cookie, so this code never sees or stores a token.
 */
const Session = { user: null };

const AuthUI = (function () {
  let mode = 'login';       // 'login' | 'register'
  let busy = false;
  const MIN_PASSWORD = 8;

  function setMode(m) {
    mode = m;
    $('auth-title').textContent = m === 'login' ? 'Sign in' : 'Create your account';
    $('auth-submit').textContent = m === 'login' ? 'Sign in' : 'Create account';
    $('auth-sub').textContent = m === 'login'
      ? 'Welcome back. Sign in to see your expenses.'
      : 'Create an account to keep your expenses private and in sync across devices.';
    $('auth-name-wrap').hidden = m !== 'register';
    $('auth-pass').autocomplete = m === 'register' ? 'new-password' : 'current-password';
    $('auth-link-register').classList.toggle('hidden', m === 'register');
    $('auth-link-login').classList.toggle('hidden', m === 'login');
    hideFeedback('auth-feedback');
  }

  async function submit() {
    if (busy) return;
    const email = $('auth-email').value.trim();
    const pass = $('auth-pass').value;
    if (!email) return showFeedback('auth-feedback', '⚠️ Please enter your email.', 'error');
    if (!pass) return showFeedback('auth-feedback', '⚠️ Please enter your password.', 'error');
    if (mode === 'register' && pass.length < MIN_PASSWORD) {
      return showFeedback('auth-feedback', `⚠️ Password must be at least ${MIN_PASSWORD} characters.`, 'error');
    }

    busy = true;
    $('auth-submit').disabled = true;
    hideFeedback('auth-feedback');
    try {
      const res = await apiFetch('POST', mode === 'login' ? '/api/auth/login' : '/api/auth/register',
        { email, password: pass, name: mode === 'register' ? $('auth-name').value.trim() : undefined });
      if (!res.ok) {
        showFeedback('auth-feedback', '⚠️ ' + (res.data.error || 'Something went wrong. Please try again.'), 'error');
      } else {
        $('auth-pass').value = '';
        startSession(res.data.user);
      }
    } catch {
      showFeedback('auth-feedback', '⚠️ Network error. Check your connection and try again.', 'error');
    } finally {
      busy = false;
      $('auth-submit').disabled = false;
    }
  }

  /** Logout: ends the session on the server (the cookie stops working), then clears the screen. */
  async function logout() {
    try {
      const res = await apiFetch('POST', '/api/auth/logout');
      if (!res.ok) throw new Error('logout failed');
    } catch {
      toast('Could not sign out — check your connection and try again.', 'error');
      return;
    }
    endSession();
  }

  function show() { $('auth-overlay').classList.remove('hidden'); setTimeout(() => $('auth-email').focus(), 0); }
  function hide() { $('auth-overlay').classList.add('hidden'); }

  return { setMode, submit, logout, show, hide };
}());
