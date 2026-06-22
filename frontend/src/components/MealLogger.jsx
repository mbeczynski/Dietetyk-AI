import React, { useState, useRef } from 'react';

export default function MealLogger({ meals, onAddMeal, onDeleteMeal, isAnalyzing }) {
  const [mealText, setMealText] = useState('');
  const [imageSrc, setImageSrc] = useState(null);
  const [isCompressing, setIsCompressing] = useState(false);
  const fileInputRef = useRef(null);

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsCompressing(true);
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        // Zmniejszenie rozmiaru obrazka do maks 800x800 px i kompresja canvas
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800;
        const MAX_HEIGHT = 800;
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

        // Kompresja do JPEG (jakość 0.7) - znacząco redukuje wagę bazy SQLite
        const compressedBase64 = canvas.toDataURL('image/jpeg', 0.7);
        setImageSrc(compressedBase64);
        setIsCompressing(false);
      };
      img.onload = img.onload.bind(this);
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!mealText.trim() && !imageSrc) return;
    onAddMeal(mealText, imageSrc);
    setMealText('');
    setImageSrc(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const getScoreClass = (score) => {
    if (score >= 8) return 'high';
    if (score >= 5) return 'med';
    return 'low';
  };

  const formatTime = (timestampStr) => {
    if (!timestampStr) return '';
    try {
      const parts = timestampStr.split(' ');
      if (parts.length >= 2) {
        return parts[1].substring(0, 5); // HH:MM
      }
      const d = new Date(timestampStr);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  };

  return (
    <div className="logger-card">
      <div className="glass-card">
        <h3 className="card-title">✍️ Co dziś jadłeś?</h3>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
          Wpisz posiłek w języku naturalnym lub <strong>dodaj zdjęcie swojego talerza</strong>. Sztuczna inteligencja automatycznie wyliczy kalorie i makro.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="textarea-wrapper">
            <textarea
              className="meal-input"
              value={mealText}
              onChange={(e) => setMealText(e.target.value)}
              placeholder="Opisz swój posiłek (np. 'Kurczak z ryżem i warzywami') lub zostaw puste, jeśli wgrywasz tylko zdjęcie..."
              disabled={isAnalyzing}
            />
          </div>

          {/* Upload Zdjęcia */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <button
                type="button"
                className="btn-primary"
                onClick={() => fileInputRef.current && fileInputRef.current.click()}
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid var(--border-glass)',
                  boxShadow: 'none',
                  color: 'var(--text-main)',
                  padding: '10px 16px',
                  fontSize: '0.9rem'
                }}
                disabled={isAnalyzing || isCompressing}
              >
                📷 {imageSrc ? 'Zmień zdjęcie' : 'Zrób/Dodaj zdjęcie'}
              </button>
              <input
                type="file"
                accept="image/*"
                ref={fileInputRef}
                onChange={handleImageChange}
                style={{ display: 'none' }}
              />
              {isCompressing && <span style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>Kompresowanie obrazu...</span>}
            </div>

            {imageSrc && (
              <div style={{ position: 'relative', width: '100%', maxWidth: '200px', height: '150px', borderRadius: '12px', overflow: 'hidden', border: '1px solid var(--border-glass)', marginTop: '8px' }}>
                <img src={imageSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="Podgląd posiłku" />
                <button
                  type="button"
                  onClick={() => {
                    setImageSrc(null);
                    if (fileInputRef.current) fileInputRef.current.value = '';
                  }}
                  style={{
                    position: 'absolute',
                    top: '8px',
                    right: '8px',
                    background: 'rgba(239, 68, 68, 0.9)',
                    color: 'white',
                    border: 'none',
                    borderRadius: '50%',
                    width: '24px',
                    height: '24px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    fontWeight: 'bold'
                  }}
                  title="Usuń zdjęcie"
                >
                  ✕
                </button>
              </div>
            )}
          </div>

          <button
            type="submit"
            className="btn-primary"
            disabled={isAnalyzing || isCompressing || (!mealText.trim() && !imageSrc)}
          >
            {isAnalyzing ? (
              <>
                <span className="loading-pulse"></span>
                <span>Analizowanie przez AI...</span>
              </>
            ) : (
              <>
                <span>🥗 Przeanalizuj posiłek</span>
              </>
            )}
          </button>
        </form>
      </div>

      <div className="glass-card">
        <h3 className="card-title">📋 Dzisiejsze posiłki</h3>
        
        {meals.length === 0 ? (
          <p className="empty-state">Brak wprowadzonych posiłków na ten dzień. Wpisz coś powyżej lub dodaj zdjęcie!</p>
        ) : (
          <div className="meals-list">
            {meals.map((meal) => (
              <div
                key={meal.id}
                className="meal-item"
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: '20px',
                  flexWrap: 'wrap'
                }}
              >
                <div style={{ flex: 1, minWidth: '250px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div className="meal-item-header">
                    <div>
                      <h4 className="meal-title">{meal.raw_text}</h4>
                      <span className="meal-time">🕒 Dodano o {formatTime(meal.timestamp)}</span>
                    </div>
                    <button
                      className="btn-delete"
                      onClick={() => onDeleteMeal(meal.id)}
                      title="Usuń posiłek"
                    >
                      🗑️
                    </button>
                  </div>

                  <div className="meal-nutrition-chips">
                    <span className="nutrition-chip calories">{meal.calories} kcal</span>
                    <span className="nutrition-chip protein">B: {Math.round(meal.protein)}g</span>
                    <span className="nutrition-chip carbs">W: {Math.round(meal.carbs)}g</span>
                    <span className="nutrition-chip fat">T: {Math.round(meal.fat)}g</span>
                    <span className={`meal-score ${getScoreClass(meal.health_rating)}`}>
                      Ocena: {meal.health_rating || 5}/10
                    </span>
                  </div>

                  {(meal.fiber != null || meal.sugar != null || meal.sodium != null) && (
                    <div className="meal-nutrition-chips" style={{ marginTop: '-4px' }}>
                      {meal.fiber != null && (
                        <span className="nutrition-chip" style={{ background: 'rgba(132, 204, 22, 0.12)', color: '#84cc16' }}>
                          Błonnik: {Math.round(meal.fiber * 10) / 10}g
                        </span>
                      )}
                      {meal.sugar != null && (
                        <span className="nutrition-chip" style={{ background: 'rgba(244, 114, 182, 0.12)', color: '#f472b6' }}>
                          Cukry: {Math.round(meal.sugar * 10) / 10}g
                        </span>
                      )}
                      {meal.sodium != null && (
                        <span className="nutrition-chip" style={{ background: 'rgba(96, 165, 250, 0.12)', color: '#60a5fa' }}>
                          Sód: {Math.round(meal.sodium)}mg
                        </span>
                      )}
                    </div>
                  )}

                  {meal.dietician_comment && (
                    <p className="meal-comment">
                      <strong>Dietetyk AI:</strong> {meal.dietician_comment}
                    </p>
                  )}

                  {meal.food_items && meal.food_items.length > 0 && (
                    <div style={{ marginTop: '8px' }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)' }}>Rozbicie na składniki:</span>
                      <ul style={{ fontSize: '0.8rem', paddingLeft: '16px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        {meal.food_items.map((item, idx) => (
                          <li key={idx} style={{ marginBottom: '2px' }}>
                            <strong>{item.name}</strong> ({item.portion}) - {item.calories} kcal | B: {item.protein}g, W: {item.carbs}g, T: {item.fat}g
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Miniatura Zdjęcia z Posiłku */}
                {meal.image_base64 && (
                  <div style={{
                    width: '120px',
                    height: '120px',
                    borderRadius: '12px',
                    overflow: 'hidden',
                    border: '1px solid var(--border-glass)',
                    flexShrink: 0,
                    boxShadow: 'var(--shadow-purple)',
                    marginTop: '4px'
                  }}>
                    <img src={meal.image_base64} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="Zdjęcie posiłku" />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
