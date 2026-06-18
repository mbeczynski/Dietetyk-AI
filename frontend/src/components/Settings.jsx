import React, { useState, useEffect } from 'react';

export default function Settings({ syncToken, sessionToken, userProfile = { username: '', avatar_base64: '' }, onProfileUpdate }) {
  const [settings, setSettings] = useState({
    target_calories: 2500,
    target_protein: 150,
    target_carbs: 250,
    target_fat: 80,
    bmr: 1800,
    target_water_ml: 2500,
    oura_client_id: '',
    oura_client_secret: '',
    withings_client_id: '',
    withings_client_secret: '',
    withings_redirect_uri: '',
    gemini_api_key: ''
  });

  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  // Stan avatara i profilu
  const [avatarMessage, setAvatarMessage] = useState({ type: '', text: '' });
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);

  // Stan zmiany hasła
  const [passwordData, setPasswordData] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState({ type: '', text: '' });

  // Stan e-mail, raportów tygodniowych i tokenu synchronizacji
  const [emailInput, setEmailInput] = useState(userProfile.email || '');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [weeklySummaryEnabled, setWeeklySummaryEnabled] = useState(userProfile.weekly_summary_enabled || false);
  const [weeklySummaryDay, setWeeklySummaryDay] = useState(userProfile.weekly_summary_day || 1);
  const [weeklySummaryTime, setWeeklySummaryTime] = useState(userProfile.weekly_summary_time || '18:00');
  const [monthlySummaryEnabled, setMonthlySummaryEnabled] = useState(userProfile.monthly_summary_enabled || false);
  const [monthlySummaryDay, setMonthlySummaryDay] = useState(userProfile.monthly_summary_day || 1);
  const [monthlySummaryTime, setMonthlySummaryTime] = useState(userProfile.monthly_summary_time || '09:00');

  // Stan zarządzania 2FA
  const [isSettingUp2fa, setIsSettingUp2fa] = useState(false);
  const [totpSetupData, setTotpSetupData] = useState({ qrCode: '', secret: '', tempToken: '' });
  const [totpSetupCode, setTotpSetupCode] = useState('');
  const [totpMessage, setTotpMessage] = useState({ type: '', text: '' });
  const [isVerifying2fa, setIsVerifying2fa] = useState(false);
  const [isDisabling2fa, setIsDisabling2fa] = useState(false);

  useEffect(() => {
    if (userProfile.email !== undefined) {
      setEmailInput(userProfile.email || '');
    }
    if (userProfile.weekly_summary_enabled !== undefined) {
      setWeeklySummaryEnabled(userProfile.weekly_summary_enabled);
    }
    if (userProfile.weekly_summary_day !== undefined) {
      setWeeklySummaryDay(userProfile.weekly_summary_day);
    }
    if (userProfile.weekly_summary_time !== undefined) {
      setWeeklySummaryTime(userProfile.weekly_summary_time);
    }
    if (userProfile.monthly_summary_enabled !== undefined) {
      setMonthlySummaryEnabled(userProfile.monthly_summary_enabled);
    }
    if (userProfile.monthly_summary_day !== undefined) {
      setMonthlySummaryDay(userProfile.monthly_summary_day);
    }
    if (userProfile.monthly_summary_time !== undefined) {
      setMonthlySummaryTime(userProfile.monthly_summary_time);
    }
  }, [userProfile]);

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/settings', {
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        setSettings(prev => ({
          ...prev,
          ...data
        }));
      }
    } catch (err) {
      console.error('Błąd pobierania ustawień:', err);
    }
  };

  const handleManualSync = async () => {
    setIsSyncing(true);
    setMessage({ type: '', text: '' });
    try {
      const res = await fetch('/api/sync/manual', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        let statusText = 'Synchronizacja zakończona pomyślnie!';
        const parts = [];
        if (data.oura) {
          parts.push(`Oura: ${data.oura.success ? '✅ Zsynchronizowano' : '❌ Błąd (' + data.oura.error + ')'}`);
        }
        if (data.withings) {
          parts.push(`Withings: ${data.withings.success ? '✅ Zsynchronizowano' : '❌ Błąd (' + data.withings.error + ')'}`);
        }
        if (parts.length > 0) {
          statusText += ` (${parts.join(', ')})`;
        }
        setMessage({ type: 'success', text: statusText });
        setTimeout(() => setMessage({ type: '', text: '' }), 10000);
      } else {
        setMessage({ type: 'error', text: 'Wystąpił błąd podczas manualnej synchronizacji.' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsSyncing(false);
    }
  };

  // Adres webhooka Apple Health (apka Health Auto Export) - zbudowany z tokenu
  // synchronizacji użytkownika (syncToken, prop z App.jsx). Backend: routes/appleHealth.js.
  const appleHealthWebhookUrl = syncToken
    ? `https://dietetyk.renacode.com/api/integrations/apple-health/${syncToken}`
    : '';

  const handleCopyWebhookUrl = async () => {
    if (!appleHealthWebhookUrl) return;
    try {
      await navigator.clipboard.writeText(appleHealthWebhookUrl);
      setMessage({ type: 'success', text: 'Skopiowano URL webhooka Apple Health do schowka!' });
      setTimeout(() => setMessage({ type: '', text: '' }), 5000);
    } catch (err) {
      setMessage({ type: 'error', text: 'Nie udało się skopiować URL do schowka.' });
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    const numericFields = ['target_calories', 'target_protein', 'target_carbs', 'target_fat', 'bmr', 'target_water_ml'];
    setSettings(prev => ({
      ...prev,
      [name]: numericFields.includes(name) ? Number(value) : value
    }));
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    setMessage({ type: '', text: '' });

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify(settings)
      });

      if (res.ok) {
        setMessage({ type: 'success', text: 'Ustawienia zostały pomyślnie zaktualizowane!' });
        onProfileUpdate();
        setTimeout(() => setMessage({ type: '', text: '' }), 5000);
      } else {
        setMessage({ type: 'error', text: 'Wystąpił błąd podczas zapisywania ustawień.' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleAvatarUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsUploadingAvatar(true);
    setAvatarMessage({ type: '', text: '' });

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 150;
        const MAX_HEIGHT = 150;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        submitAvatar(dataUrl);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  };

  const submitAvatar = async (base64Data) => {
    try {
      const res = await fetch('/api/user/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ avatar: base64Data })
      });

      if (res.ok) {
        setAvatarMessage({ type: 'success', text: 'Avatar został zaktualizowany!' });
        onProfileUpdate();
        setTimeout(() => setAvatarMessage({ type: '', text: '' }), 5000);
      } else {
        setAvatarMessage({ type: 'error', text: 'Błąd podczas wgrywania avatara.' });
      }
    } catch (err) {
      setAvatarMessage({ type: 'error', text: 'Błąd połączenia z serwerem.' });
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const handleRemoveAvatar = async () => {
    if (!confirm('Czy chcesz usunąć swoje zdjęcie profilowe?')) return;
    setIsUploadingAvatar(true);
    submitAvatar(null);
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPasswordMessage({ type: '', text: '' });

    if (passwordData.newPassword !== passwordData.confirmPassword) {
      setPasswordMessage({ type: 'error', text: 'Nowe hasła nie są identyczne!' });
      return;
    }

    setIsChangingPassword(true);
    try {
      const res = await fetch('/api/user/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          currentPassword: passwordData.currentPassword,
          newPassword: passwordData.newPassword
        })
      });

      if (res.ok) {
        setPasswordMessage({ type: 'success', text: 'Hasło zostało pomyślnie zmienione!' });
        setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' });
        setTimeout(() => setPasswordMessage({ type: '', text: '' }), 5000);
      } else {
        const data = await res.json();
        setPasswordMessage({ type: 'error', text: data.error || 'Błąd podczas zmiany hasła.' });
      }
    } catch (err) {
      setPasswordMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleSaveProfile = async (e) => {
    e.preventDefault();
    setIsSavingProfile(true);
    setAvatarMessage({ type: '', text: '' });

    try {
      const res = await fetch('/api/user/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          email: emailInput,
          weekly_summary_enabled: weeklySummaryEnabled ? '1' : '0',
          weekly_summary_day: String(weeklySummaryDay),
          weekly_summary_time: weeklySummaryTime,
          monthly_summary_enabled: monthlySummaryEnabled ? '1' : '0',
          monthly_summary_day: String(monthlySummaryDay),
          monthly_summary_time: monthlySummaryTime
        })
      });

      if (res.ok) {
        setAvatarMessage({ type: 'success', text: 'Profil został pomyślnie zaktualizowany!' });
        onProfileUpdate();
        setTimeout(() => setAvatarMessage({ type: '', text: '' }), 5000);
      } else {
        const data = await res.json();
        setAvatarMessage({ type: 'error', text: data.error || 'Wystąpił błąd podczas zapisywania profilu.' });
      }
    } catch (err) {
      setAvatarMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleSendTestEmail = async (type = 'weekly') => {
    setIsSendingEmail(true);
    setAvatarMessage({ type: '', text: '' });

    try {
      const endpoint = type === 'daily' ? '/api/user/send-daily-summary' : (type === 'monthly' ? '/api/user/send-monthly-summary' : '/api/user/send-weekly-summary');
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ email: emailInput })
      });

      if (res.ok) {
        const data = await res.json();
        const typeLabel = type === 'daily' ? 'Codzienne' : (type === 'monthly' ? 'Miesięczne' : 'Tygodniowe');
        let successText = `${typeLabel} podsumowanie zostało wysłane na e-mail!`;
        if (data.previewUrl) {
          successText += ` (Podgląd testowy Ethereal: ${data.previewUrl})`;
        }
        setAvatarMessage({ type: 'success', text: successText });
        setTimeout(() => setAvatarMessage({ type: '', text: '' }), 15000);
      } else {
        const data = await res.json();
        setAvatarMessage({ type: 'error', text: data.error || 'Błąd wysyłania e-maila.' });
      }
    } catch (err) {
      setAvatarMessage({ type: 'error', text: 'Błąd połączenia z serwerem.' });
    } finally {
      setIsSendingEmail(false);
    }
  };

  const handleSetup2FA = async () => {
    setTotpMessage({ type: '', text: '' });
    try {
      const res = await fetch('/api/user/setup-2fa', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        setTotpSetupData({
          qrCode: data.qrCode,
          secret: data.secret,
          tempToken: data.tempToken
        });
        setIsSettingUp2fa(true);
      } else {
        const data = await res.json();
        setTotpMessage({ type: 'error', text: data.error || 'Błąd inicjalizacji setupu 2FA.' });
      }
    } catch (err) {
      setTotpMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    }
  };

  const handleVerify2FASetup = async (e) => {
    e.preventDefault();
    if (!totpSetupCode.trim()) return;
    setIsVerifying2fa(true);
    setTotpMessage({ type: '', text: '' });

    try {
      const res = await fetch('/api/user/verify-2fa', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          tempToken: totpSetupData.tempToken,
          code: totpSetupCode
        })
      });

      if (res.ok) {
        setTotpMessage({ type: 'success', text: 'Dwuetapowa weryfikacja (2FA) została aktywowana!' });
        setIsSettingUp2fa(false);
        setTotpSetupCode('');
        onProfileUpdate();
        setTimeout(() => setTotpMessage({ type: '', text: '' }), 5000);
      } else {
        const data = await res.json();
        setTotpMessage({ type: 'error', text: data.error || 'Niepoprawny kod weryfikacyjny.' });
      }
    } catch (err) {
      setTotpMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsVerifying2fa(false);
    }
  };

  const handleDisable2FA = async () => {
    if (!confirm('Czy na pewno chcesz wyłączyć dwuetapową weryfikację (2FA) na swoim koncie? Obniży to bezpieczeństwo profilu.')) return;
    setIsDisabling2fa(true);
    setTotpMessage({ type: '', text: '' });

    try {
      const res = await fetch('/api/user/disable-2fa', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });

      if (res.ok) {
        setTotpMessage({ type: 'success', text: 'Weryfikacja dwuetapowa została wyłączona.' });
        onProfileUpdate();
        setTimeout(() => setTotpMessage({ type: '', text: '' }), 5000);
      } else {
        const data = await res.json();
        setTotpMessage({ type: 'error', text: data.error || 'Błąd podczas wyłączania 2FA.' });
      }
    } catch (err) {
      setTotpMessage({ type: 'error', text: 'Problem z połączeniem z serwerem.' });
    } finally {
      setIsDisabling2fa(false);
    }
  };

  const handleDisconnect = async (service) => {
    if (!confirm(`Czy na pewno chcesz odłączyć integrację z ${service === 'oura' ? 'Oura' : 'Withings'}?`)) return;
    try {
      const res = await fetch(`/api/auth/${service}/disconnect`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        onProfileUpdate();
        setMessage({ type: 'success', text: `Odłączono integrację z ${service === 'oura' ? 'Oura' : 'Withings'}!` });
        setTimeout(() => setMessage({ type: '', text: '' }), 5000);
      } else {
        setMessage({ type: 'error', text: 'Nie udało się odłączyć integracji.' });
      }
    } catch (err) {
      console.error(err);
      setMessage({ type: 'error', text: 'Błąd połączenia z serwerem.' });
    }
  };

  const handleConnect = async (service) => {
    // WAŻNE: zapisujemy bieżący stan formularza (Client ID/Secret) PRZED przekierowaniem.
    // Wcześniej przycisk "Połącz" od razu robił window.location.href, więc jeśli
    // użytkownik wpisał dane i kliknął "Połącz" bez wcześniejszego kliknięcia
    // odrębnego przycisku "Zapisz poświadczenia integracji" na dole formularza,
    // backend przy budowaniu URL-a OAuth czytał z bazy starą/pustą wartość -
    // stąd zgłoszony błąd z client_id=0 w adresie autoryzacji Withings.
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify(settings)
      });
    } catch (err) {
      console.error('Błąd zapisu ustawień przed połączeniem:', err);
    }
    window.location.href = `${window.location.origin}/api/auth/${service}?token=${sessionToken}`;
  };

  return (
    <div className="setup-container">
      
      {/* 1. Panel Ustawień Celów */}
      <div className="glass-card">
        <h3 className="card-title">⚙️ Twoje Cele Dietetyczne</h3>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
          Skonfiguruj swoje dzienne limity, aby Dietetyk AI mógł poprawnie obliczać Twój bilans i dawać spersonalizowane porady.
        </p>

        {message.text && (
          <div className={`alert alert-${message.type}`}>
            {message.text}
          </div>
        )}

        <form onSubmit={handleSave}>
          <div className="settings-grid">
            <div className="input-group">
              <label className="input-label">Cel kalorii (kcal)</label>
              <input
                type="number"
                name="target_calories"
                className="input-field"
                value={settings.target_calories}
                onChange={handleInputChange}
                required
              />
            </div>
            
            <div className="input-group">
              <label className="input-label">BMR / PPM (kcal)*</label>
              <input
                type="number"
                name="bmr"
                className="input-field"
                value={settings.bmr}
                onChange={handleInputChange}
                title="Podstawowa przemiana materii - kalorie, które Twój organizm spala na samo przeżycie leżąc."
                required
              />
            </div>

            <div className="input-group">
              <label className="input-label">Białko (g)</label>
              <input
                type="number"
                name="target_protein"
                className="input-field"
                value={settings.target_protein}
                onChange={handleInputChange}
                required
              />
            </div>

            <div className="input-group">
              <label className="input-label">Węglowodany (g)</label>
              <input
                type="number"
                name="target_carbs"
                className="input-field"
                value={settings.target_carbs}
                onChange={handleInputChange}
                required
              />
            </div>

            <div className="input-group">
              <label className="input-label">Tłuszcz (g)</label>
              <input
                type="number"
                name="target_fat"
                className="input-field"
                value={settings.target_fat}
                onChange={handleInputChange}
                required
              />
            </div>

            <div className="input-group">
              <label className="input-label">Cel wody (ml)</label>
              <input
                type="number"
                name="target_water_ml"
                className="input-field"
                value={settings.target_water_ml}
                onChange={handleInputChange}
                required
              />
            </div>
          </div>
          
          <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '16px' }}>
            * BMR (Podstawowa przemiana materii) służy do wyliczania całkowitego dziennego spalania: Całkowite spalanie = BMR + Aktywne kalorie ze zintegrowanych sensorów.
          </p>

          <button type="submit" className="btn-primary" disabled={isSaving}>
            {isSaving ? 'Zapisywanie...' : 'Zapisz cele'}
          </button>
        </form>
      </div>

      {/* Panel Profilu (Avatar) oraz Zmiany Hasła */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '24px' }}>
        
        {/* Panel Profilu i Avatara */}
        <div className="glass-card">
          <h3 className="card-title">👤 Twój Profil i Avatar</h3>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
            Wgraj zdjęcie profilowe, które będzie wyświetlane w nagłówku aplikacji.
          </p>

          {avatarMessage.text && (
            <div className={`alert alert-${avatarMessage.type}`} style={{ marginBottom: '16px' }}>
              {avatarMessage.text}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap', marginBottom: '20px' }}>
            {userProfile.avatar_base64 ? (
              <img 
                src={userProfile.avatar_base64} 
                alt="Avatar" 
                style={{ width: '80px', height: '80px', borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--primary-color)' }} 
              />
            ) : (
              <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: 'linear-gradient(135deg, var(--primary-color), var(--primary-hover))', color: '#fff', display: 'flex', justifyContent: 'center', alignItems: 'center', fontWeight: 'bold', fontSize: '2.5rem', border: '2px solid var(--border-glass)' }}>
                {userProfile.username ? userProfile.username[0].toUpperCase() : '?'}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label className="btn-primary" style={{ padding: '8px 16px', fontSize: '0.9rem', display: 'inline-block', cursor: 'pointer', textAlign: 'center' }}>
                Wybierz zdjęcie
                <input 
                  type="file" 
                  accept="image/*" 
                  onChange={handleAvatarUpload} 
                  style={{ display: 'none' }} 
                  disabled={isUploadingAvatar}
                />
              </label>
              {userProfile.avatar_base64 && (
                <button 
                  type="button" 
                  className="btn-secondary" 
                  onClick={handleRemoveAvatar}
                  style={{ padding: '6px 12px', fontSize: '0.8rem', background: 'rgba(239, 68, 68, 0.1)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.2)' }}
                >
                  Usuń zdjęcie
                </button>
              )}
            </div>
          </div>

          <form onSubmit={handleSaveProfile} style={{ display: 'flex', flexDirection: 'column', gap: '16px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '16px' }}>
            <div className="input-group">
              <label className="input-label">Adres e-mail do raportów</label>
              <input 
                type="email" 
                className="input-field" 
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                placeholder="np. mbeczynski@gmail.com"
                required
              />
            </div>

            <div style={{ borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <input 
                  type="checkbox" 
                  id="weekly_summary_enabled"
                  checked={weeklySummaryEnabled}
                  onChange={(e) => setWeeklySummaryEnabled(e.target.checked)}
                  style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--color-primary)' }}
                />
                <label htmlFor="weekly_summary_enabled" style={{ fontSize: '0.9rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
                  Włącz podsumowanie
                </label>
              </div>

              {weeklySummaryEnabled && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px' }}>
                  <div className="input-group">
                    <label className="input-label">Dzień wysyłki</label>
                    <select 
                      className="input-field" 
                      value={weeklySummaryDay}
                      onChange={(e) => setWeeklySummaryDay(Number(e.target.value))}
                      style={{ background: 'rgba(0, 0, 0, 0.2)', color: 'white', border: '1px solid var(--border-glass)' }}
                    >
                      <option value={1}>Poniedziałek</option>
                      <option value={2}>Wtorek</option>
                      <option value={3}>Środa</option>
                      <option value={4}>Czwartek</option>
                      <option value={5}>Piątek</option>
                      <option value={6}>Sobota</option>
                      <option value={7}>Niedziela</option>
                    </select>
                  </div>
                  
                  <div className="input-group">
                    <label className="input-label">Godzina wysyłki</label>
                    <input 
                      type="time" 
                      className="input-field" 
                      value={weeklySummaryTime}
                      onChange={(e) => setWeeklySummaryTime(e.target.value)}
                      required
                    />
                  </div>
                </div>
              )}
            </div>

            <div style={{ borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <input
                  type="checkbox"
                  id="monthly_summary_enabled"
                  checked={monthlySummaryEnabled}
                  onChange={(e) => setMonthlySummaryEnabled(e.target.checked)}
                  style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: 'var(--color-primary)' }}
                />
                <label htmlFor="monthly_summary_enabled" style={{ fontSize: '0.9rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
                  Włącz raport miesięczny
                </label>
              </div>

              {monthlySummaryEnabled && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px' }}>
                  <div className="input-group">
                    <label className="input-label">Dzień miesiąca</label>
                    <input
                      type="number"
                      min="1"
                      max="31"
                      className="input-field"
                      value={monthlySummaryDay}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setMonthlySummaryDay(Math.min(31, Math.max(1, val || 1)));
                      }}
                      title="Jeśli dany miesiąc jest krótszy (np. luty), raport zostanie wysłany w ostatnim dniu tego miesiąca."
                      required
                    />
                  </div>

                  <div className="input-group">
                    <label className="input-label">Godzina wysyłki</label>
                    <input
                      type="time"
                      className="input-field"
                      value={monthlySummaryTime}
                      onChange={(e) => setMonthlySummaryTime(e.target.value)}
                      required
                    />
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '16px' }}>
              <button type="submit" className="btn-primary" disabled={isSavingProfile} style={{ width: '100%' }}>
                {isSavingProfile ? 'Zapisywanie...' : 'Zapisz profil'}
              </button>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => handleSendTestEmail('daily')}
                  disabled={isSendingEmail || !emailInput}
                  style={{ border: '1px solid var(--border-glass)', padding: '12px', fontSize: '0.85rem' }}
                >
                  {isSendingEmail ? 'Wysyłanie...' : 'Wyślij codzienne'}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => handleSendTestEmail('weekly')}
                  disabled={isSendingEmail || !emailInput}
                  style={{ border: '1px solid var(--border-glass)', padding: '12px', fontSize: '0.85rem' }}
                >
                  {isSendingEmail ? 'Wysyłanie...' : 'Wyślij tygodniowe'}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => handleSendTestEmail('monthly')}
                  disabled={isSendingEmail || !emailInput}
                  style={{ border: '1px solid var(--border-glass)', padding: '12px', fontSize: '0.85rem' }}
                >
                  {isSendingEmail ? 'Wysyłanie...' : 'Wyślij miesięczne'}
                </button>
              </div>
            </div>
          </form>
        </div>

        {/* Panel Zmiany Hasła */}
        <div className="glass-card">
          <h3 className="card-title">🔑 Zmiana Hasła</h3>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
            Zmień hasło logowania dla swojego konta.
          </p>

          {passwordMessage.text && (
            <div className={`alert alert-${passwordMessage.type}`} style={{ marginBottom: '16px' }}>
              {passwordMessage.text}
            </div>
          )}

          <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div className="input-group">
              <label className="input-label">Obecne hasło</label>
              <input 
                type="password" 
                className="input-field" 
                value={passwordData.currentPassword}
                onChange={(e) => setPasswordData(prev => ({ ...prev, currentPassword: e.target.value }))}
                required
              />
            </div>

            <div className="input-group">
              <label className="input-label">Nowe hasło</label>
              <input 
                type="password" 
                className="input-field" 
                value={passwordData.newPassword}
                onChange={(e) => setPasswordData(prev => ({ ...prev, newPassword: e.target.value }))}
                required
              />
            </div>

            <div className="input-group">
              <label className="input-label">Powtórz nowe hasło</label>
              <input 
                type="password" 
                className="input-field" 
                value={passwordData.confirmPassword}
                onChange={(e) => setPasswordData(prev => ({ ...prev, confirmPassword: e.target.value }))}
                required
              />
            </div>

            <button type="submit" className="btn-primary" disabled={isChangingPassword} style={{ marginTop: '8px' }}>
              {isChangingPassword ? 'Zmienianie...' : 'Zmień hasło'}
            </button>
          </form>
        </div>

        {/* Panel 2FA (MFA) */}
        <div className="glass-card">
          <h3 className="card-title">🛡️ Dwuetapowa Weryfikacja (2FA)</h3>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
            Zabezpiecz dodatkowo swoje konto za pomocą kodu z aplikacji Google Authenticator lub Authy.
          </p>

          {totpMessage.text && (
            <div className={`alert alert-${totpMessage.type}`} style={{ marginBottom: '16px' }}>
              {totpMessage.text}
            </div>
          )}

          {userProfile.totp_enabled ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px', background: 'rgba(16, 185, 129, 0.05)', border: '1px solid rgba(16, 185, 129, 0.2)', borderRadius: '8px', color: '#34d399', fontSize: '0.9rem' }}>
                <span>🛡️</span>
                <strong>Weryfikacja 2FA jest aktywna.</strong>
              </div>
              <button 
                type="button" 
                className="btn-secondary" 
                onClick={handleDisable2FA}
                disabled={isDisabling2fa}
                style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.2)', width: '100%', padding: '10px' }}
              >
                {isDisabling2fa ? 'Wyłączanie...' : 'Wyłącz 2FA'}
              </button>
            </div>
          ) : !isSettingUp2fa ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px', background: 'rgba(245, 158, 11, 0.05)', border: '1px solid rgba(245, 158, 11, 0.2)', borderRadius: '8px', color: '#fbbf24', fontSize: '0.9rem' }}>
                <span>🔓</span>
                <strong>Weryfikacja 2FA jest nieaktywna.</strong>
              </div>
              <button 
                type="button" 
                className="btn-primary" 
                onClick={handleSetup2FA}
                style={{ width: '100%', padding: '10px' }}
              >
                Skonfiguruj i Włącz 2FA
              </button>
            </div>
          ) : (
            <form onSubmit={handleVerify2FASetup} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                Zeskanuj ten kod w aplikacji autoryzacyjnej i podaj 6-cyfrowy kod, aby włączyć zabezpieczenie.
              </p>
              
              <div style={{ display: 'flex', justifyContent: 'center', margin: '10px 0' }}>
                <img 
                  src={totpSetupData.qrCode} 
                  alt="QR Code" 
                  style={{ borderRadius: '12px', border: '1px solid var(--border-glass)', padding: '6px', background: '#fff', width: '150px', height: '150px' }} 
                />
              </div>

              <div className="input-group">
                <label className="input-label">Kod z aplikacji (6 cyfr)</label>
                <input
                  type="text"
                  pattern="[0-9]*"
                  inputMode="numeric"
                  maxLength="6"
                  className="input-field"
                  value={totpSetupCode}
                  onChange={(e) => setTotpSetupCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000 000"
                  required
                  autoFocus
                />
              </div>

              <div style={{ display: 'flex', gap: '10px' }}>
                <button 
                  type="button" 
                  className="btn-secondary" 
                  onClick={() => setIsSettingUp2fa(false)}
                  style={{ flex: 1, padding: '8px' }}
                >
                  Anuluj
                </button>
                <button 
                  type="submit" 
                  className="btn-primary" 
                  disabled={isVerifying2fa}
                  style={{ flex: 2, padding: '8px' }}
                >
                  {isVerifying2fa ? 'Weryfikacja...' : 'Aktywuj 2FA'}
                </button>
              </div>
            </form>
          )}
        </div>

      </div>

      {/* 2. Integracje ze Źródłami Danych */}
      <div className="glass-card">
        <h3 className="card-title">🔌 Integracje ze Źródłami Danych</h3>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '24px' }}>
          Skonfiguruj swoje poświadczenia deweloperskie i połącz konto z API Oura Ring oraz Withings, aby automatycznie importować dane o aktywności, śnie, wadze i składzie ciała.
        </p>

        {/* Komunikat o wyniku akcji (np. synchronizacji lub odłączenia integracji) -
            zduplikowany tutaj, bo oryginalny alert renderuje się tylko w karcie "Cele
            Dietetyczne" na samym szczycie strony. Bez tego, kliknięcie "Wymuś ręczną
            synchronizację" (które jest w tej karcie, niżej na stronie) nie dawało
            żadnej widocznej reakcji, jeśli użytkownik nie przewinął strony do góry. */}
        {message.text && (
          <div className={`alert alert-${message.type}`} style={{ marginBottom: '16px' }}>
            {message.text}
          </div>
        )}

        {(userProfile.has_oura || userProfile.has_withings) && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '20px' }}>
            <button
              type="button"
              className="btn-primary"
              style={{
                background: 'rgba(59, 130, 246, 0.15)',
                color: '#60a5fa',
                border: '1px solid rgba(59, 130, 246, 0.3)',
                padding: '10px 20px',
                fontSize: '0.9rem',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                borderRadius: '8px',
                cursor: isSyncing ? 'not-allowed' : 'pointer'
              }}
              onClick={handleManualSync}
              disabled={isSyncing}
            >
              {isSyncing ? '🔄 Synchronizowanie...' : '🔄 Wymuś ręczną synchronizację'}
            </button>
          </div>
        )}

        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Oura Ring */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            padding: '16px',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--border-glass)',
            borderRadius: '12px',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '2rem' }}>💍</span>
                <div>
                  <strong style={{ display: 'block', color: '#fff' }}>Oura Ring (Sen, HRV, Aktywność)</strong>
                  <span style={{ fontSize: '0.8rem', color: userProfile.has_oura ? '#34d399' : 'var(--text-dim)' }}>
                    {userProfile.has_oura ? '✅ Połączono z kontem Oura' : '❌ Brak połączenia'}
                  </span>
                </div>
              </div>
              <div>
                {userProfile.has_oura ? (
                  <button
                    type="button"
                    className="btn-secondary"
                    style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.2)', padding: '8px 16px' }}
                    onClick={() => handleDisconnect('oura')}
                  >
                    Odłącz Oura
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ padding: '8px 16px' }}
                    onClick={() => handleConnect('oura')}
                    disabled={!settings.oura_client_id || !settings.oura_client_secret}
                    title={(!settings.oura_client_id || !settings.oura_client_secret) ? 'Wpisz Client ID i Secret, aby połączyć' : ''}
                  >
                    Połącz z Oura
                  </button>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
                <div className="input-group">
                  <label className="input-label" style={{ fontSize: '0.8rem' }}>Oura Client ID</label>
                  <input
                    type="text"
                    name="oura_client_id"
                    className="input-field"
                    style={{ padding: '8px 12px', fontSize: '0.85rem' }}
                    value={settings.oura_client_id || ''}
                    onChange={handleInputChange}
                    placeholder="Wpisz Oura Client ID..."
                  />
                </div>
                <div className="input-group">
                  <label className="input-label" style={{ fontSize: '0.8rem' }}>Oura Client Secret</label>
                  <input
                    type="password"
                    name="oura_client_secret"
                    className="input-field"
                    style={{ padding: '8px 12px', fontSize: '0.85rem' }}
                    value={settings.oura_client_secret || ''}
                    onChange={handleInputChange}
                    placeholder="Wpisz Oura Client Secret..."
                  />
                </div>
              </div>
              <div style={{ fontSize: '0.8rem', color: '#fbbf24', background: 'rgba(251, 191, 36, 0.05)', border: '1px solid rgba(251, 191, 36, 0.15)', padding: '10px', borderRadius: '8px', marginTop: '4px', lineHeight: '1.4' }}>
                ⚠️ <strong>Ważne:</strong> Upewnij się, że w konfiguracji Twojej aplikacji na 
                <a href="https://cloud.ouraring.com/developer/manage" target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', textDecoration: 'underline', marginLeft: '4px', marginRight: '4px' }}>
                  Oura Developer Portal
                </a> zaznaczyłeś zakresy (scopes) <strong>"daily"</strong> (dane dobowe), <strong>"heartrate"</strong> oraz <strong>"personal"</strong>. Bez tych zakresów API Oura zwróci błąd autoryzacji (401 - Token is not authorized access daily scope) i pobranie parametrów snu, gotowości oraz aktywności nie powiedzie się. Po zmianie zakresów na portalu Oura, odłącz i połącz Oura ponownie w aplikacji.
              </div>
            </div>
          </div>

          {/* Withings */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            padding: '16px',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--border-glass)',
            borderRadius: '12px',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '2rem' }}>⚖️</span>
                <div>
                  <strong style={{ display: 'block', color: '#fff' }}>Withings (Waga, Skład ciała)</strong>
                  <span style={{ fontSize: '0.8rem', color: userProfile.has_withings ? '#34d399' : 'var(--text-dim)' }}>
                    {userProfile.has_withings ? '✅ Połączono z kontem Withings' : '❌ Brak połączenia'}
                  </span>
                </div>
              </div>
              <div>
                {userProfile.has_withings ? (
                  <button
                    type="button"
                    className="btn-secondary"
                    style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.2)', padding: '8px 16px' }}
                    onClick={() => handleDisconnect('withings')}
                  >
                    Odłącz Withings
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ padding: '8px 16px' }}
                    onClick={() => handleConnect('withings')}
                    disabled={!settings.withings_client_id || !settings.withings_client_secret}
                    title={(!settings.withings_client_id || !settings.withings_client_secret) ? 'Wpisz Client ID i Secret, aby połączyć' : ''}
                  >
                    Połącz z Withings
                  </button>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
                <div className="input-group">
                  <label className="input-label" style={{ fontSize: '0.8rem' }}>Withings Client ID</label>
                  <input
                    type="text"
                    name="withings_client_id"
                    className="input-field"
                    style={{ padding: '8px 12px', fontSize: '0.85rem' }}
                    value={settings.withings_client_id || ''}
                    onChange={handleInputChange}
                    placeholder="Wpisz Withings Client ID..."
                  />
                </div>
                <div className="input-group">
                  <label className="input-label" style={{ fontSize: '0.8rem' }}>Withings Client Secret</label>
                  <input
                    type="password"
                    name="withings_client_secret"
                    className="input-field"
                    style={{ padding: '8px 12px', fontSize: '0.85rem' }}
                    value={settings.withings_client_secret || ''}
                    onChange={handleInputChange}
                    placeholder="Wpisz Withings Client Secret..."
                  />
                </div>
                <div className="input-group" style={{ gridColumn: 'span 2' }}>
                  <label className="input-label" style={{ fontSize: '0.8rem' }}>Withings Custom Redirect URI (Opcjonalnie)</label>
                  <input
                    type="text"
                    name="withings_redirect_uri"
                    className="input-field"
                    style={{ padding: '8px 12px', fontSize: '0.85rem' }}
                    value={settings.withings_redirect_uri || ''}
                    onChange={handleInputChange}
                    placeholder="np. https://dietetyk.renacode.com/api/auth/oura/callback"
                  />
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '4px', display: 'block' }}>
                    Domyślnie używany jest: <code>https://dietetyk.renacode.com/api/auth/withings/callback</code>. Jeżeli w portalu Withings Developer masz zarejestrowany inny (np. <code>https://dietetyk.renacode.com/api/auth/oura/callback</code>), wpisz go powyżej.
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Apple Health (poprzez Health Auto Export) */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            padding: '16px',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--border-glass)',
            borderRadius: '12px',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '2rem' }}>🍏</span>
              <div>
                <strong style={{ display: 'block', color: '#fff' }}>Apple Health (Kroki, Kalorie, Minuty Aktywności)</strong>
                <span style={{ fontSize: '0.8rem', color: '#34d399' }}>
                  ✅ Webhook gotowy do skonfigurowania
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '12px' }}>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: 0, lineHeight: '1.5' }}>
                Dane aktywności z Apple Health docierają od razu (w przeciwieństwie do Oura, która finalizuje dobowe podsumowanie zwykle następnego ranka). Gdy obie integracje są aktywne, dane z Oura są traktowane jako bardziej wiarygodne i nadpisują wartości wcześniej wpisane przez Apple Health dla tego samego dnia.
              </p>

              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.8rem' }}>URL webhooka (wklej w apce Health Auto Export)</label>
                <div className="code-block">
                  <span>{appleHealthWebhookUrl}</span>
                  <button type="button" className="btn-copy" onClick={handleCopyWebhookUrl}>
                    Kopiuj
                  </button>
                </div>
              </div>

              <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', lineHeight: '1.6' }}>
                <strong style={{ color: 'var(--text-muted)' }}>Konfiguracja w apce Health Auto Export (iOS):</strong>
                <ol style={{ margin: '6px 0 0', paddingLeft: '20px' }}>
                  <li>Zainstaluj apkę <strong>Health Auto Export</strong> z App Store.</li>
                  <li>Przejdź do zakładki <strong>Automations</strong> i utwórz nową automatyzację typu <strong>REST API</strong>.</li>
                  <li>Wklej powyższy URL jako adres docelowy, format danych: <strong>JSON</strong>.</li>
                  <li>Wybierz metryki: <strong>Steps</strong>, <strong>Active Energy</strong>, <strong>Basal Energy Burned</strong>, <strong>Apple Exercise Time</strong>.</li>
                  <li>Ustaw harmonogram automatycznego wysyłania (np. co godzinę) lub wysyłaj ręcznie.</li>
                </ol>
              </div>
            </div>
          </div>

          {/* Gemini AI API Key */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            padding: '16px',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid var(--border-glass)',
            borderRadius: '12px',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '2rem' }}>🤖</span>
              <div>
                <strong style={{ display: 'block', color: '#fff' }}>Gemini AI (Inteligentne Analizy i Wskazówki)</strong>
                <span style={{ fontSize: '0.8rem', color: settings.gemini_api_key ? '#34d399' : 'var(--text-dim)' }}>
                  {settings.gemini_api_key ? '✅ Klucz skonfigurowany' : '❌ Brak skonfigurowanego klucza'}
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '12px' }}>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.8rem' }}>Gemini API Key</label>
                <input
                  type="password"
                  name="gemini_api_key"
                  className="input-field"
                  style={{ padding: '8px 12px', fontSize: '0.85rem' }}
                  value={settings.gemini_api_key || ''}
                  onChange={handleInputChange}
                  placeholder="Wpisz swój klucz API Gemini..."
                />
              </div>
            </div>
          </div>

          <button type="submit" className="btn-primary" disabled={isSaving} style={{ width: '100%', padding: '12px', marginTop: '10px' }}>
            {isSaving ? 'Zapisywanie...' : 'Zapisz poświadczenia integracji'}
          </button>
        </form>
      </div>
    </div>
  );
}
