import React, { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard';
import MealLogger from './components/MealLogger';
import ActivityTracker from './components/ActivityTracker';
import Settings from './components/Settings';
import AdminPanel from './components/AdminPanel';
import Trends from './components/Trends';

// Pomocnicza funkcja pobierająca dzisiejszą datę w formacie YYYY-MM-DD
function getLocalDateString() {
  const d = new Date();
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 10);
}

export default function App() {
  const [currentTab, setCurrentTab] = useState('dashboard');
  const [selectedDate, setSelectedDate] = useState(getLocalDateString());
  const [sessionToken, setSessionToken] = useState(localStorage.getItem('diet_session_token') || '');
  const [usernameInput, setUsernameInput] = useState('admin');
  const [passwordInput, setPasswordInput] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [loginStep, setLoginStep] = useState('password'); // 'password', 'setup_2fa', 'require_2fa', 'force_password_change'
  const [tempToken, setTempToken] = useState('');
  const [qrCode, setQrCode] = useState('');
  const [loginError, setLoginError] = useState('');
  const [newPasswordForced, setNewPasswordForced] = useState('');
  const [confirmPasswordForced, setConfirmPasswordForced] = useState('');

  // Public registration states
  const [isPublicRegister, setIsPublicRegister] = useState(false);
  const [registerUsernameInput, setRegisterUsernameInput] = useState('');
  const [registerPasswordInput, setRegisterPasswordInput] = useState('');
  const [registerConfirmPasswordInput, setRegisterConfirmPasswordInput] = useState('');
  const [registerEmailInput, setRegisterEmailInput] = useState('');
  
  // Modal state
  const [showTermsModal, setShowTermsModal] = useState(false);

  const handlePublicRegister = async (e) => {
    e.preventDefault();
    setLoginError('');

    if (registerPasswordInput !== registerConfirmPasswordInput) {
      setLoginError('Hasła nie są identyczne.');
      return;
    }

    try {
      const res = await fetch('/api/register-public', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          username: registerUsernameInput,
          password: registerPasswordInput,
          email: registerEmailInput
        })
      });

      const data = await res.json();

      if (res.ok) {
        if (data.token) {
          setSessionToken(data.token);
          localStorage.setItem('diet_session_token', data.token);
          setIsPublicRegister(false);
          setRegisterUsernameInput('');
          setRegisterPasswordInput('');
          setRegisterConfirmPasswordInput('');
          setRegisterEmailInput('');
        } else {
          setTempToken(data.tempToken);
          setQrCode(data.qrCode);
          setLoginStep('setup_2fa');
          setIsPublicRegister(false);
          setRegisterUsernameInput('');
          setRegisterPasswordInput('');
          setRegisterConfirmPasswordInput('');
          setRegisterEmailInput('');
        }
      } else {
        setLoginError(data.error || 'Błąd rejestracji.');
      }
    } catch (err) {
      setLoginError('Błąd połączenia z serwerem.');
    }
  };

  // Rejestracja z zaproszenia
  const [registerToken, setRegisterToken] = useState('');
  const [invitedEmail, setInvitedEmail] = useState('');
  const [registerError, setRegisterError] = useState('');
  const [registerUsername, setRegisterUsername] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerConfirmPassword, setRegisterConfirmPassword] = useState('');
  const [isCheckingToken, setIsCheckingToken] = useState(false);
  const [dashboardData, setDashboardData] = useState({
    summary: {
      target_calories: 2500,
      target_protein: 150,
      target_carbs: 250,
      target_fat: 80,
      bmr: 1800,
      calories_eaten: 0,
      calories_burned_active: 0,
      calories_burned_total: 1800,
      net_calories: -1800,
      eaten_protein: 0,
      eaten_carbs: 0,
      eaten_fat: 0,
      steps: 0,
      workouts: [],
      last_sync: null
    },
    meals: [],
    aiAdvice: 'Ładowanie porad dietetyka...'
  });
  const [syncToken, setSyncToken] = useState('secure-diet-token-123');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [userProfile, setUserProfile] = useState({ username: '', avatar_base64: '' });

  // Pobierz dane przy załadowaniu i przy zmianie daty lub sesji
  useEffect(() => {
    if (sessionToken) {
      fetchDashboardData();
      fetchSyncToken();
      fetchUserProfile();
    }
  }, [selectedDate, sessionToken]);

  useEffect(() => {
    if (sessionToken) {
      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get('tab');
      const successParam = params.get('success');
      const errorParam = params.get('error');

      if (tabParam) {
        setCurrentTab(tabParam);
      }

      if (successParam === 'oura') {
        setSuccessMessage('Pomyślnie zintegrowano z Oura Ring!');
        setTimeout(() => setSuccessMessage(''), 6000);
        window.history.replaceState({}, document.title, '/');
        fetchUserProfile();
        fetchDashboardData();
      } else if (successParam === 'withings') {
        setSuccessMessage('Pomyślnie zintegrowano z Withings!');
        setTimeout(() => setSuccessMessage(''), 6000);
        window.history.replaceState({}, document.title, '/');
        fetchUserProfile();
        fetchDashboardData();
      } else if (errorParam) {
        let msg = 'Wystąpił błąd podczas integracji.';
        if (errorParam === 'oura_auth_failed' || errorParam === 'oura_exchange_failed') {
          msg = 'Nie udało się połączyć z Oura Ring. Sprawdź poświadczenia w panelu admina.';
        } else if (errorParam === 'withings_auth_failed' || errorParam === 'withings_exchange_failed') {
          msg = 'Nie udało się połączyć z Withings. Sprawdź poświadczenia w panelu admina.';
        }
        setErrorMessage(msg);
        setTimeout(() => setErrorMessage(''), 6000);
        window.history.replaceState({}, document.title, '/');
      }
    }
  }, [sessionToken]);

  useEffect(() => {
    if (window.location.pathname === '/register') {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      if (token) {
        setRegisterToken(token);
        checkInvitationStatus(token);
      } else {
        setRegisterError('Brak tokenu zaproszenia w adresie URL.');
      }
    }
  }, []);

  const checkInvitationStatus = async (token) => {
    setIsCheckingToken(true);
    try {
      const res = await fetch(`/api/invitation-status?token=${token}`);
      if (res.ok) {
        const data = await res.json();
        setInvitedEmail(data.email);
      } else {
        const data = await res.json();
        setRegisterError(data.error || 'Nieprawidłowy lub wygasły token zaproszenia.');
      }
    } catch (err) {
      setRegisterError('Błąd połączenia z serwerem.');
    } finally {
      setIsCheckingToken(false);
    }
  };

  const handleRegisterSubmit = async (e) => {
    e.preventDefault();
    setRegisterError('');

    if (registerPassword !== registerConfirmPassword) {
      setRegisterError('Hasła nie są identyczne.');
      return;
    }

    try {
      const res = await fetch('/api/register-invitation', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          token: registerToken,
          username: registerUsername,
          password: registerPassword
        })
      });

      const data = await res.json();

      if (res.ok) {
        if (data.token) {
          setSessionToken(data.token);
          localStorage.setItem('diet_session_token', data.token);
          window.history.replaceState({}, document.title, '/');
          setRegisterToken('');
        } else {
          setTempToken(data.tempToken);
          setQrCode(data.qrCode);
          setLoginStep('setup_2fa');
          window.history.replaceState({}, document.title, '/');
          setRegisterToken('');
        }
      } else {
        setRegisterError(data.error || 'Błąd rejestracji.');
      }
    } catch (err) {
      setRegisterError('Błąd połączenia z serwerem.');
    }
  };

  const fetchUserProfile = async () => {
    if (!sessionToken) return;
    try {
      const res = await fetch('/api/user/profile', {
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        setUserProfile(data);
      }
    } catch (err) {
      console.error('Błąd pobierania profilu:', err);
    }
  };

  const fetchDashboardData = async () => {
    if (!sessionToken) return;
    setIsLoading(true);
    setErrorMessage('');
    try {
      const res = await fetch(`/api/dashboard?date=${selectedDate}`, {
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        setDashboardData({
          summary: data.summary,
          meals: data.meals,
          aiAdvice: data.aiAdvice
        });
      } else {
        if (res.status === 401) {
          handleLogout();
          setErrorMessage('Sesja wygasła. Zaloguj się ponownie.');
        } else {
          setErrorMessage('Nie udało się pobrać danych z serwera backend.');
        }
      }
    } catch (err) {
      console.error(err);
      setErrorMessage('Błąd połączenia z serwerem. Upewnij się, że backend działa.');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchSyncToken = async () => {
    if (!sessionToken) return;
    try {
      const res = await fetch('/api/settings', {
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.sync_token) {
          setSyncToken(data.sync_token);
        }
      } else if (res.status === 401) {
        handleLogout();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleAddMeal = async (rawText, imageBase64) => {
    setIsAnalyzing(true);
    setErrorMessage('');
    try {
      const res = await fetch('/api/meals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          rawText,
          date: selectedDate,
          image: imageBase64
        })
      });

      if (res.ok) {
        // Pomyślnie dodano posiłek - przeładuj dashboard
        await fetchDashboardData();
      } else {
        if (res.status === 401) {
          handleLogout();
          setErrorMessage('Sesja wygasła. Zaloguj się ponownie.');
        } else {
          const errData = await res.json();
          setErrorMessage(errData.error || 'Błąd podczas analizowania posiłku.');
        }
      }
    } catch (err) {
      setErrorMessage('Nie udało się połączyć z serwerem w celu analizy posiłku.');
      console.error(err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleDeleteMeal = async (id) => {
    if (!confirm('Czy na pewno chcesz usunąć ten posiłek?')) return;
    
    try {
      const res = await fetch(`/api/meals/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        await fetchDashboardData();
      } else {
        if (res.status === 401) {
          handleLogout();
          setErrorMessage('Sesja wygasła. Zaloguj się ponownie.');
        } else {
          setErrorMessage('Nie udało się usunąć posiłku.');
        }
      }
    } catch (err) {
      console.error(err);
      setErrorMessage('Problem z połączeniem przy usuwaniu posiłku.');
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    if (!passwordInput.trim()) return;

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username: usernameInput, password: passwordInput })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.status === 'require_2fa') {
          setTempToken(data.tempToken);
          setLoginStep('require_2fa');
          setTotpCode('');
        } else if (data.status === 'setup_2fa') {
          setTempToken(data.tempToken);
          setQrCode(data.qrCode);
          setLoginStep('setup_2fa');
          setTotpCode('');
        } else if (data.status === 'force_password_change') {
          setTempToken(data.tempToken);
          setLoginStep('force_password_change');
          setNewPasswordForced('');
          setConfirmPasswordForced('');
        } else {
          setSessionToken(data.token);
          localStorage.setItem('diet_session_token', data.token);
        }
      } else {
        const errData = await res.json();
        setLoginError(errData.error || 'Nieprawidłowe dane logowania.');
      }
    } catch (err) {
      setLoginError('Błąd połączenia z serwerem.');
      console.error(err);
    }
  };

  const handleForcePasswordChange = async (e) => {
    e.preventDefault();
    setLoginError('');

    if (newPasswordForced !== confirmPasswordForced) {
      setLoginError('Hasła nie są identyczne.');
      return;
    }

    try {
      const res = await fetch('/api/change-password-forced', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tempToken, newPassword: newPasswordForced })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.status === 'require_2fa') {
          setTempToken(data.tempToken);
          setLoginStep('require_2fa');
          setTotpCode('');
        } else if (data.status === 'setup_2fa') {
          setTempToken(data.tempToken);
          setQrCode(data.qrCode);
          setLoginStep('setup_2fa');
          setTotpCode('');
        } else {
          setSessionToken(data.token);
          localStorage.setItem('diet_session_token', data.token);
          setLoginStep('password');
          setPasswordInput('');
          setNewPasswordForced('');
          setConfirmPasswordForced('');
        }
      } else {
        const errData = await res.json();
        setLoginError(errData.error || 'Błąd podczas zmiany hasła.');
      }
    } catch (err) {
      setLoginError('Błąd połączenia z serwerem.');
      console.error(err);
    }
  };

  const handleVerifySetup2FA = async (e) => {
    e.preventDefault();
    setLoginError('');
    if (!totpCode.trim() || !tempToken) return;

    try {
      const res = await fetch('/api/verify-2fa-setup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tempToken, code: totpCode })
      });

      if (res.ok) {
        const data = await res.json();
        setSessionToken(data.token);
        localStorage.setItem('diet_session_token', data.token);
        setLoginStep('password');
        setPasswordInput('');
        setTotpCode('');
      } else {
        const errData = await res.json();
        setLoginError(errData.error || 'Niepoprawny kod 2FA.');
      }
    } catch (err) {
      setLoginError('Błąd połączenia z serwerem.');
    }
  };

  const handleLogin2FA = async (e) => {
    e.preventDefault();
    setLoginError('');
    if (!totpCode.trim() || !tempToken) return;

    try {
      const res = await fetch('/api/login-2fa', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tempToken, code: totpCode })
      });

      if (res.ok) {
        const data = await res.json();
        setSessionToken(data.token);
        localStorage.setItem('diet_session_token', data.token);
        setLoginStep('password');
        setPasswordInput('');
        setTotpCode('');
      } else {
        const errData = await res.json();
        setLoginError(errData.error || 'Niepoprawny kod 2FA.');
      }
    } catch (err) {
      setLoginError('Błąd połączenia z serwerem.');
    }
  };

  const handleLogout = async () => {
    if (sessionToken) {
      try {
        await fetch('/api/logout', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${sessionToken}`
          }
        });
      } catch (e) {
        console.error(e);
      }
    }
    setSessionToken('');
    localStorage.removeItem('diet_session_token');
    setLoginStep('password');
    setUserProfile({ username: '', avatar_base64: '' });
    setDashboardData({
      summary: {
        target_calories: 2500,
        target_protein: 150,
        target_carbs: 250,
        target_fat: 80,
        bmr: 1800,
        calories_eaten: 0,
        calories_burned_active: 0,
        calories_burned_total: 1800,
        net_calories: -1800,
        eaten_protein: 0,
        eaten_carbs: 0,
        eaten_fat: 0,
        steps: 0,
        workouts: [],
        last_sync: null
      },
      meals: [],
      aiAdvice: 'Zaloguj się, aby zobaczyć porady.'
    });
  };

  if (registerToken) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '80vh', padding: '16px', position: 'relative', zIndex: 10 }}>
        <div className="glass-card" style={{ width: '100%', maxWidth: '400px', textAlign: 'center' }}>
          <span style={{ fontSize: '3rem' }}>🥗</span>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', marginBottom: '10px' }}>Utwórz Konto</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '24px' }}>
            Dokończ rejestrację w aplikacji Dietetyk AI.
          </p>

          {registerError && (
            <div className="alert alert-error" style={{ marginBottom: '16px' }}>
              ⚠️ {registerError}
            </div>
          )}

          {isCheckingToken ? (
            <div style={{ color: 'var(--text-muted)' }}>Weryfikacja tokenu zaproszenia...</div>
          ) : invitedEmail ? (
            <form onSubmit={handleRegisterSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px', textAlign: 'left' }}>
              <div className="input-group">
                <label className="input-label">Zaproszony e-mail</label>
                <div style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.05)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', color: 'var(--text-muted)', fontSize: '0.95rem' }}>
                  {invitedEmail}
                </div>
              </div>

              <div className="input-group">
                <label className="input-label">Nazwa użytkownika (login)</label>
                <input
                  type="text"
                  className="input-field"
                  value={registerUsername}
                  onChange={(e) => setRegisterUsername(e.target.value)}
                  placeholder="Wybierz nazwę użytkownika..."
                  required
                />
              </div>

              <div className="input-group">
                <label className="input-label">Hasło dostępowe</label>
                <input
                  type="password"
                  className="input-field"
                  value={registerPassword}
                  onChange={(e) => setRegisterPassword(e.target.value)}
                  placeholder="Wpisz silne hasło..."
                  required
                />
              </div>

              <div className="input-group">
                <label className="input-label">Powtórz hasło</label>
                <input
                  type="password"
                  className="input-field"
                  value={registerConfirmPassword}
                  onChange={(e) => setRegisterConfirmPassword(e.target.value)}
                  placeholder="Powtórz hasło..."
                  required
                />
              </div>

              <button type="submit" className="btn-primary" style={{ width: '100%', padding: '12px', marginTop: '8px' }}>
                Zarejestruj się i przejdź do 2FA
              </button>
            </form>
          ) : (
            <div>
              <p style={{ color: 'var(--text-muted)', marginBottom: '16px' }}>Link jest nieprawidłowy, wygasł lub został już użyty.</p>
              <button className="btn-primary" onClick={() => { setRegisterToken(''); window.history.replaceState({}, document.title, '/'); }} style={{ width: '100%' }}>
                Przejdź do logowania
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!sessionToken) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', minHeight: '90vh', padding: '16px', position: 'relative', zIndex: 10 }}>
        <div className="glass-card" style={{ width: '100%', maxWidth: '400px', textAlign: 'center', marginBottom: '20px' }}>
          <span style={{ fontSize: '3rem' }}>🥗</span>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', marginBottom: '10px' }}>Dietetyk AI</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '24px' }}>
            Twój osobisty asystent żywieniowy.
          </p>

          {loginError && (
            <div className="alert alert-error" style={{ marginBottom: '16px' }}>
              ⚠️ {loginError}
            </div>
          )}

          {isPublicRegister ? (
            <form onSubmit={handlePublicRegister} style={{ display: 'flex', flexDirection: 'column', gap: '16px', textAlign: 'left' }}>
              <div className="input-group">
                <label className="input-label">Nazwa użytkownika (login)</label>
                <input
                  type="text"
                  className="input-field"
                  value={registerUsernameInput}
                  onChange={(e) => setRegisterUsernameInput(e.target.value)}
                  placeholder="Wybierz nazwę..."
                  required
                />
              </div>

              <div className="input-group">
                <label className="input-label">E-mail (opcjonalnie)</label>
                <input
                  type="email"
                  className="input-field"
                  value={registerEmailInput}
                  onChange={(e) => setRegisterEmailInput(e.target.value)}
                  placeholder="np. mbeczynski@gmail.com"
                />
              </div>

              <div className="input-group">
                <label className="input-label">Hasło</label>
                <input
                  type="password"
                  className="input-field"
                  value={registerPasswordInput}
                  onChange={(e) => setRegisterPasswordInput(e.target.value)}
                  placeholder="Wpisz silne hasło..."
                  required
                />
              </div>

              <div className="input-group">
                <label className="input-label">Powtórz hasło</label>
                <input
                  type="password"
                  className="input-field"
                  value={registerConfirmPasswordInput}
                  onChange={(e) => setRegisterConfirmPasswordInput(e.target.value)}
                  placeholder="Powtórz hasło..."
                  required
                />
              </div>

              <button type="submit" className="btn-primary" style={{ width: '100%', padding: '12px' }}>
                Zarejestruj się
              </button>

              <button 
                type="button" 
                className="btn-secondary" 
                onClick={() => { setIsPublicRegister(false); setLoginError(''); }}
                style={{ width: '100%', background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.85rem', textAlign: 'center', marginTop: '4px' }}
              >
                Masz już konto? Zaloguj się
              </button>
            </form>
          ) : (
            <>
              {loginStep === 'password' && (
                <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div className="input-group" style={{ textAlign: 'left' }}>
                    <label className="input-label">Nazwa użytkownika</label>
                    <input
                      type="text"
                      className="input-field"
                      value={usernameInput}
                      onChange={(e) => setUsernameInput(e.target.value)}
                      placeholder="Wpisz nazwę użytkownika..."
                      style={{ width: '100%' }}
                      required
                    />
                  </div>

                  <div className="input-group" style={{ textAlign: 'left' }}>
                    <label className="input-label">Hasło dostępowe</label>
                    <input
                      type="password"
                      className="input-field"
                      value={passwordInput}
                      onChange={(e) => setPasswordInput(e.target.value)}
                      placeholder="Wpisz hasło..."
                      autoFocus
                      required
                    />
                  </div>

                  <button type="submit" className="btn-primary" style={{ width: '100%', padding: '12px' }}>
                    Dalej
                  </button>

                  <button 
                    type="button" 
                    className="btn-secondary" 
                    onClick={() => { setIsPublicRegister(true); setLoginError(''); }}
                    style={{ width: '100%', background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.85rem', textAlign: 'center', marginTop: '4px' }}
                  >
                    Nie masz konta? Zarejestruj się
                  </button>
                </form>
              )}

              {loginStep === 'setup_2fa' && (
                <form onSubmit={handleVerifySetup2FA} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <h3 style={{ fontSize: '1.1rem', color: 'var(--text-main)', marginBottom: '8px' }}>🔐 Skonfiguruj 2FA</h3>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                    Zeskanuj poniższy kod QR w aplikacji **Google Authenticator** lub **Authy**, a następnie wpisz wygenerowany 6-cyfrowy kod.
                  </p>
                  
                  <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0' }}>
                    <img src={qrCode} alt="2FA QR" style={{ borderRadius: '12px', border: '1px solid var(--border-glass)', padding: '6px', background: '#fff', width: '180px', height: '180px' }} />
                  </div>

                  <div className="input-group" style={{ textAlign: 'left' }}>
                    <label className="input-label">6-cyfrowy kod weryfikacyjny</label>
                    <input
                      type="text"
                      pattern="[0-9]*"
                      inputMode="numeric"
                      maxLength="6"
                      className="input-field"
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="000 000"
                      autoFocus
                      required
                    />
                  </div>

                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button type="button" className="btn-secondary" onClick={() => setLoginStep('password')} style={{ flex: 1, padding: '10px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-glass)', color: 'var(--text-muted)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
                      Wróć
                    </button>
                    <button type="submit" className="btn-primary" style={{ flex: 2, padding: '10px' }}>
                      Aktywuj i Zaloguj
                    </button>
                  </div>
                </form>
              )}

              {loginStep === 'require_2fa' && (
                <form onSubmit={handleLogin2FA} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <h3 style={{ fontSize: '1.1rem', color: 'var(--text-main)', marginBottom: '8px' }}>🔐 Dwuetapowa weryfikacja</h3>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                    Wprowadź 6-cyfrowy kod wygenerowany przez aplikację autoryzacyjną na Twoim telefonie.
                  </p>

                  <div className="input-group" style={{ textAlign: 'left' }}>
                    <label className="input-label">Kod weryfikacyjny 2FA</label>
                    <input
                      type="text"
                      pattern="[0-9]*"
                      inputMode="numeric"
                      maxLength="6"
                      className="input-field"
                      value={totpCode}
                      onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="000 000"
                      autoFocus
                      required
                    />
                  </div>

                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button type="button" className="btn-secondary" onClick={() => setLoginStep('password')} style={{ flex: 1, padding: '10px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-glass)', color: 'var(--text-muted)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
                      Wróć
                    </button>
                    <button type="submit" className="btn-primary" style={{ flex: 2, padding: '10px' }}>
                      Zaloguj się
                    </button>
                  </div>
                </form>
              )}

              {loginStep === 'force_password_change' && (
                <form onSubmit={handleForcePasswordChange} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <h3 style={{ fontSize: '1.1rem', color: 'var(--text-main)', marginBottom: '8px' }}>🔑 Wymuszona zmiana hasła</h3>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                    Administrator wymusił zmianę hasła dla Twojego konta. Wprowadź nowe hasło poniżej.
                  </p>

                  <div className="input-group" style={{ textAlign: 'left' }}>
                    <label className="input-label">Nowe hasło</label>
                    <input
                      type="password"
                      className="input-field"
                      value={newPasswordForced}
                      onChange={(e) => setNewPasswordForced(e.target.value)}
                      placeholder="Wpisz nowe hasło..."
                      autoFocus
                      required
                    />
                  </div>

                  <div className="input-group" style={{ textAlign: 'left' }}>
                    <label className="input-label">Powtórz nowe hasło</label>
                    <input
                      type="password"
                      className="input-field"
                      value={confirmPasswordForced}
                      onChange={(e) => setConfirmPasswordForced(e.target.value)}
                      placeholder="Powtórz nowe hasło..."
                      required
                    />
                  </div>

                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button type="button" className="btn-secondary" onClick={() => setLoginStep('password')} style={{ flex: 1, padding: '10px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-glass)', color: 'var(--text-muted)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
                      Anuluj
                    </button>
                    <button type="submit" className="btn-primary" style={{ flex: 2, padding: '10px' }}>
                      Zapisz i zaloguj
                    </button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', textAlign: 'center' }}>
          Dietetyk AI v1.1.0 | Powered by <a href="https://renacode.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>RenaCode</a> | <a href="/terms.html" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-dim)', fontSize: '0.8rem', textDecoration: 'underline', marginRight: '10px' }}>Regulamin</a> | <a href="/privacy.html" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-dim)', fontSize: '0.8rem', textDecoration: 'underline' }}>Polityka Prywatności</a>
        </div>

        {/* Modal regulaminu */}
        {showTermsModal && (
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(7, 9, 19, 0.85)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 9999,
            padding: '20px'
          }}>
            <div className="glass-card" style={{ maxWidth: '600px', width: '100%', maxHeight: '80vh', overflowY: 'auto', textAlign: 'left', position: 'relative' }}>
              <button 
                type="button" 
                onClick={() => setShowTermsModal(false)} 
                style={{
                  position: 'absolute',
                  top: '15px',
                  right: '15px',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  fontSize: '1.25rem',
                  cursor: 'pointer'
                }}
              >
                ✕
              </button>
              <h3 className="card-title" style={{ marginBottom: '16px' }}>📜 Regulamin Serwisu i Polityka Prywatności</h3>
              <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: '1.6', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <p><strong>1. Postanowienia ogólne</strong><br />
                Aplikacja Dietetyk AI (zwana dalej „Serwisem”) jest osobistym asystentem żywieniowym i treningowym. Korzystanie z Serwisu wymaga akceptacji niniejszego Regulaminu.</p>
                
                <p><strong>2. Rejestracja i Bezpieczeństwo Konta</strong><br />
                Każdy użytkownik zobowiązany jest do zabezpieczenia swojego konta za pomocą dwuetapowej weryfikacji (2FA) przy pierwszym logowaniu. Zabrania się udostępniania danych logowania osobom trzecim.</p>
                
                <p><strong>3. Przetwarzanie i synchronizacja danych</strong><br />
                Serwis umożliwia synchronizację danych aktywności z Apple Health za pomocą webhooka oraz analizowanie wprowadzanych posiłków przez zewnętrzną sztuczną inteligencję (Gemini AI). Przesyłane dane są przechowywane w bazie danych serwisu w celu wyliczania bilansu kalorycznego.</p>
                
                <p><strong>4. Analiza AI i Odpowiedzialność</strong><br />
                Wszelkie analizy żywieniowe, wartości kaloryczne makroskładników oraz porady dietetyczne generowane przez Gemini AI mają charakter wyłącznie edukacyjno-informacyjny. Nie zastępują one profesjonalnej porady medycznej, lekarskiej ani dietetycznej. Użytkownik korzysta z Serwisu na własną odpowiedzialność.</p>
                
                <p><strong>5. Licencja</strong><br />
                Kod źródłowy Serwisu jest rozpowszechniany na warunkach otwartoźródłowej licencji MIT. Użytkownik ma prawo do korzystania z Serwisu zgodnie z jej postanowieniami.</p>
                
                <p><strong>6. Zmiany Regulaminu</strong><br />
                Serwis zastrzega sobie prawo do wprowadzania zmian w niniejszym Regulaminie. Aktualna wersja jest zawsze dostępna w stopce Serwisu.</p>
                
                <p style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginTop: '10px' }}>Ostatnia aktualizacja: 15.06.2026 r.</p>
              </div>
              <button 
                type="button" 
                className="btn-primary" 
                onClick={() => setShowTermsModal(false)}
                style={{ width: '100%', marginTop: '20px', padding: '10px' }}
              >
                Zamknij
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app-container">
      <header>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
          <div className="logo-container">
            <span className="logo-icon">🥗</span>
            <div>
              <span className="logo-text">Dietetyk AI</span>
              <span className="logo-badge">Gemini AI</span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 12px', background: 'rgba(255, 255, 255, 0.05)', borderRadius: '20px', border: '1px solid var(--border-glass)' }}>
            {userProfile.avatar_base64 ? (
              <img src={userProfile.avatar_base64} alt="Avatar" style={{ width: '24px', height: '24px', borderRadius: '50%', objectFit: 'cover' }} />
            ) : (
              <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: 'linear-gradient(135deg, var(--primary-color), var(--primary-hover))', color: '#fff', display: 'flex', justifyContent: 'center', alignItems: 'center', fontWeight: 'bold', fontSize: '0.8rem' }}>
                {userProfile.username ? userProfile.username[0].toUpperCase() : '?'}
              </div>
            )}
            <span style={{ fontSize: '0.85rem', color: 'var(--text-main)', fontWeight: 500 }}>{userProfile.username}</span>
          </div>
        </div>

        <nav className="nav-tabs">
          <button
            className={`nav-tab ${currentTab === 'dashboard' ? 'active' : ''}`}
            onClick={() => setCurrentTab('dashboard')}
          >
            Dashboard
          </button>
          <button
            className={`nav-tab ${currentTab === 'meals' ? 'active' : ''}`}
            onClick={() => setCurrentTab('meals')}
          >
            Dziennik Posiłków
          </button>
          <button
            className={`nav-tab ${currentTab === 'trends' ? 'active' : ''}`}
            onClick={() => setCurrentTab('trends')}
          >
            Trendy
          </button>
          <button
            className={`nav-tab ${currentTab === 'activity' ? 'active' : ''}`}
            onClick={() => setCurrentTab('activity')}
          >
            Aktywność
          </button>
          <button
            className={`nav-tab ${currentTab === 'setup' ? 'active' : ''}`}
            onClick={() => setCurrentTab('setup')}
          >
            Ustawienia
          </button>
          {userProfile.role === 'admin' && (
            <button
              className={`nav-tab ${currentTab === 'admin' ? 'active' : ''}`}
              onClick={() => setCurrentTab('admin')}
            >
              Panel Admina
            </button>
          )}
          <button
            className="nav-tab"
            onClick={handleLogout}
            style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.15)' }}
          >
            Wyloguj
          </button>
        </nav>
      </header>

      {/* Kontrolki globalne: Data i Błędy */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
        <div className="date-selector">
          <span>Dzień:</span>
          <input
            type="date"
            className="date-input"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
          />
        </div>

        {isLoading && <div style={{ fontSize: '0.9rem', color: 'var(--text-dim)' }}>Aktualizowanie danych...</div>}
      </div>

      {errorMessage && (
        <div className="alert alert-error">
          ⚠️ {errorMessage}
        </div>
      )}

      {successMessage && (
        <div className="alert alert-success">
          ✅ {successMessage}
        </div>
      )}

      {/* Wyświetlanie aktywnej zakładki */}
      <main>
        {currentTab === 'dashboard' && (
          <Dashboard summary={dashboardData.summary} aiAdvice={dashboardData.aiAdvice} sessionToken={sessionToken} selectedDate={selectedDate} onNavigate={setCurrentTab} />
        )}

        {currentTab === 'meals' && (
          <MealLogger
            meals={dashboardData.meals}
            onAddMeal={handleAddMeal}
            onDeleteMeal={handleDeleteMeal}
            isAnalyzing={isAnalyzing}
          />
        )}

        {currentTab === 'activity' && (
          <ActivityTracker summary={dashboardData.summary} userProfile={userProfile} sessionToken={sessionToken} onGoalsUpdate={fetchDashboardData} />
        )}

        {currentTab === 'trends' && (
          <Trends selectedDate={selectedDate} sessionToken={sessionToken} />
        )}

        {currentTab === 'setup' && (
          <Settings syncToken={syncToken} sessionToken={sessionToken} userProfile={userProfile} onProfileUpdate={() => { fetchUserProfile(); fetchSyncToken(); fetchDashboardData(); }} />
        )}

        {currentTab === 'admin' && userProfile.role === 'admin' && (
          <AdminPanel sessionToken={sessionToken} />
        )}
      </main>

      {/* Footer wewnątrz aplikacji */}
      <footer>
        <div style={{ textAlign: 'center', marginTop: '40px', padding: '20px 0', borderTop: '1px solid var(--border-glass)', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
          Dietetyk AI v1.1.0 | Powered by <a href="https://renacode.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>RenaCode</a> | <a href="/terms.html" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textDecoration: 'underline', marginRight: '10px' }}>Regulamin</a> | <a href="/privacy.html" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textDecoration: 'underline' }}>Polityka Prywatności</a>
        </div>
      </footer>

      {/* Modal regulaminu */}
      {showTermsModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(7, 9, 19, 0.85)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 9999,
          padding: '20px'
        }}>
          <div className="glass-card" style={{ maxWidth: '600px', width: '100%', maxHeight: '80vh', overflowY: 'auto', textAlign: 'left', position: 'relative' }}>
            <button 
              type="button" 
              onClick={() => setShowTermsModal(false)} 
              style={{
                position: 'absolute',
                top: '15px',
                right: '15px',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                fontSize: '1.25rem',
                cursor: 'pointer'
              }}
            >
              ✕
            </button>
            <h3 className="card-title" style={{ marginBottom: '16px' }}>📜 Regulamin Serwisu i Polityka Privacidad</h3>
            <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: '1.6', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <p><strong>1. Postanowienia ogólne</strong><br />
              Aplikacja Dietetyk AI (zwana dalej „Serwisem”) jest osobistym asystentem żywieniowym i treningowym. Korzystanie z Serwisu wymaga akceptacji niniejszego Regulaminu.</p>
              
              <p><strong>2. Rejestracja i Bezpieczeństwo Konta</strong><br />
              Każdy użytkownik zobowiązany jest do zabezpieczenia swojego konta za pomocą dwuetapowej weryfikacji (2FA) przy pierwszym logowaniu. Zabrania się udostępniania danych logowania osobom trzecim.</p>
              
              <p><strong>3. Przetwarzanie i synchronizacja danych</strong><br />
              Serwis umożliwia synchronizację danych aktywności z Apple Health za pomocą webhooka oraz analizowanie wprowadzanych posiłków przez zewnętrzną sztuczną inteligencję (Gemini AI). Przesyłane dane są przechowywane w bazie danych serwisu w celu wyliczania bilansu kalorycznego.</p>
              
              <p><strong>4. Analiza AI i Odpowiedzialność</strong><br />
              Wszelkie analizy żywieniowe, wartości kaloryczne makroskładników oraz porady dietetyczne generowane przez Gemini AI mają charakter wyłącznie edukacyjno-informacyjny. Nie zastępują one profesjonalnej porady medycznej, lekarskiej ani dietetycznej. Użytkownik korzysta z Serwisu na własną odpowiedzialność.</p>
              
              <p><strong>5. Licencja</strong><br />
              Kod źródłowy Serwisu jest rozpowszechniany na warunkach otwartoźródłowej licencji MIT. Użytkownik ma prawo do korzystania z Serwisu zgodnie z jej postanowieniami.</p>
              
              <p><strong>6. Zmiany Regulaminu</strong><br />
              Serwis zastrzega sobie prawo do wprowadzania zmian w niniejszym Regulaminie. Aktualna wersja jest zawsze dostępna w stopce Serwisu.</p>
              
              <p style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginTop: '10px' }}>Ostatnia aktualizacja: 15.06.2026 r.</p>
            </div>
            <button 
              type="button" 
              className="btn-primary" 
              onClick={() => setShowTermsModal(false)}
              style={{ width: '100%', marginTop: '20px', padding: '10px' }}
            >
              Zamknij
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
