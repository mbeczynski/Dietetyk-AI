import React, { useState, useEffect } from 'react';

export default function ActivityTracker({ summary, userProfile, sessionToken, onGoalsUpdate }) {
  const [historyData, setHistoryData] = useState([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // Stany pomiarów obwodów ciała
  const [measurementsData, setMeasurementsData] = useState([]);

  // Cele aktywności
  const [goals, setGoals] = useState({
    target_steps: 10000,
    target_active_calories: 500,
    target_sleep_duration: 7.2,
    target_active_minutes: 30
  });
  const [isSavingGoals, setIsSavingGoals] = useState(false);
  const [goalsMessage, setGoalsMessage] = useState({ type: '', text: '' });

  useEffect(() => {
    if (summary) {
      setGoals({
        target_steps: summary.target_steps || 10000,
        target_active_calories: summary.target_active_calories || 500,
        target_sleep_duration: summary.target_sleep_duration || 7.2,
        target_active_minutes: summary.target_active_minutes || 30
      });
    }
  }, [summary]);

  const handleSaveGoals = async (e) => {
    e.preventDefault();
    setIsSavingGoals(true);
    setGoalsMessage({ type: '', text: '' });
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify(goals)
      });
      if (res.ok) {
        setGoalsMessage({ type: 'success', text: 'Cele zostały zaktualizowane!' });
        if (onGoalsUpdate) {
          onGoalsUpdate();
        }
        setTimeout(() => setGoalsMessage({ type: '', text: '' }), 5000);
      } else {
        setGoalsMessage({ type: 'error', text: 'Błąd zapisu celów.' });
      }
    } catch (err) {
      setGoalsMessage({ type: 'error', text: 'Błąd połączenia z serwerem.' });
    } finally {
      setIsSavingGoals(false);
    }
  };
  const [isLoadingMeasurements, setIsLoadingMeasurements] = useState(false);
  const [selectedMeasure, setSelectedMeasure] = useState('waist');
  const [isSavingMeasurement, setIsSavingMeasurement] = useState(false);
  const [measurementMessage, setMeasurementMessage] = useState({ type: '', text: '' });
  const [formMeasurement, setFormMeasurement] = useState({
    date: new Date().toISOString().split('T')[0],
    chest: '',
    waist: '',
    hips: '',
    biceps: '',
    thigh: ''
  });

  useEffect(() => {
    const fetchHistory = async () => {
      if (!sessionToken) return;
      setIsLoadingHistory(true);
      try {
        const res = await fetch('/api/health/history', {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) {
          const data = await res.json();
          setHistoryData(data);
        }
      } catch (err) {
        console.error('Błąd pobierania historii zdrowotnej:', err);
      } finally {
        setIsLoadingHistory(false);
      }
    };
    fetchHistory();
  }, [sessionToken, summary.last_sync]);

  useEffect(() => {
    fetchMeasurements();
  }, [sessionToken]);

  const fetchMeasurements = async () => {
    if (!sessionToken) return;
    setIsLoadingMeasurements(true);
    try {
      const res = await fetch('/api/body-measurements', {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        setMeasurementsData(data);
      }
    } catch (err) {
      console.error('Błąd pobierania obwodów ciała:', err);
    } finally {
      setIsLoadingMeasurements(false);
    }
  };

  const handleFormMeasurementChange = (e) => {
    const { name, value } = e.target;
    setFormMeasurement(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleSaveMeasurement = async (e) => {
    e.preventDefault();
    setIsSavingMeasurement(true);
    setMeasurementMessage({ type: '', text: '' });
    try {
      const res = await fetch('/api/body-measurements', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify(formMeasurement)
      });
      if (res.ok) {
        setMeasurementMessage({ type: 'success', text: 'Zapisano pomiary pomyślnie!' });
        setFormMeasurement({
          date: new Date().toISOString().split('T')[0],
          chest: '',
          waist: '',
          hips: '',
          biceps: '',
          thigh: ''
        });
        fetchMeasurements();
        setTimeout(() => setMeasurementMessage({ type: '', text: '' }), 5000);
      } else {
        const errData = await res.json();
        setMeasurementMessage({ type: 'error', text: errData.error || 'Błąd zapisu pomiarów.' });
      }
    } catch (err) {
      setMeasurementMessage({ type: 'error', text: 'Błąd połączenia z serwerem.' });
    } finally {
      setIsSavingMeasurement(false);
    }
  };

  const handleDeleteMeasurement = async (id) => {
    if (!window.confirm('Czy na pewno chcesz usunąć ten pomiar?')) return;
    try {
      const res = await fetch(`/api/body-measurements/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${sessionToken}`
        }
      });
      if (res.ok) {
        fetchMeasurements();
      }
    } catch (err) {
      console.error('Błąd usuwania pomiaru:', err);
    }
  };

  const getMeasureLabel = (key) => {
    switch(key) {
      case 'waist': return 'Talia / Pas (cm)';
      case 'chest': return 'Klatka piersiowa (cm)';
      case 'hips': return 'Biodra (cm)';
      case 'biceps': return 'Biceps (cm)';
      case 'thigh': return 'Udo (cm)';
      default: return 'Obwód (cm)';
    }
  };

  const formatSyncTime = (isoString) => {
    if (!isoString) return 'Nigdy';
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' (' + date.toLocaleDateString() + ')';
    } catch (e) {
      return isoString;
    }
  };

  const getMinMax = (data, key) => {
    const values = data.map(d => d[key]).filter(v => v !== null && v !== undefined);
    if (values.length === 0) return { min: 0, max: 100 };
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    const padding = range === 0 ? 5 : range * 0.15;
    return { min: Math.max(0, min - padding), max: max + padding };
  };

  const renderLineChart = (data, key, color, labelY) => {
    const validData = data.filter(d => d[key] !== null && d[key] !== undefined);
    if (validData.length === 0) {
      return (
        <div style={{ height: '180px', display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
          Brak danych historycznych dla: {labelY}
        </div>
      );
    }

    const width = 500;
    const height = 180;
    const padding = 35;

    const { min, max } = getMinMax(validData, key);

    const points = validData.map((d, index) => {
      const x = padding + (index / (validData.length - 1 || 1)) * (width - 2 * padding);
      const y = height - padding - ((d[key] - min) / (max - min || 1)) * (height - 2 * padding);
      return { x, y, val: d[key], date: d.date };
    });

    const dPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

    return (
      <div style={{ position: 'relative' }}>
        <svg width="100%" height="180" viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
          {/* Grid lines */}
          <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="rgba(255,255,255,0.03)" />
          <line x1={padding} y1={(height) / 2} x2={width - padding} y2={(height) / 2} stroke="rgba(255,255,255,0.03)" />
          <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(255,255,255,0.08)" />

          {/* Labels Y */}
          <text x={padding - 8} y={padding + 4} fill="var(--text-dim)" fontSize="9" textAnchor="end">{max.toFixed(1)}</text>
          <text x={padding - 8} y={height - padding + 4} fill="var(--text-dim)" fontSize="9" textAnchor="end">{min.toFixed(1)}</text>

          {/* Line Path */}
          <path d={dPath} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />

          {/* Vertex dots */}
          {points.map((p, i) => (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r="4" fill={color} stroke="#0f111a" strokeWidth="2" />
              {validData.length <= 15 && (
                <text x={p.x} y={p.y - 8} fill="#fff" fontSize="8" textAnchor="middle" fontWeight="600">{p.val.toFixed(1)}</text>
              )}
            </g>
          ))}

          {/* Dates labels on X axis */}
          {points.filter((_, i) => i === 0 || i === points.length - 1 || (points.length > 5 && i === Math.floor(points.length / 2))).map((p, i) => (
            <text key={i} x={p.x} y={height - 10} fill="var(--text-dim)" fontSize="9" textAnchor="middle">
              {p.date.slice(5)}
            </text>
          ))}
        </svg>
      </div>
    );
  };

  const renderDualAxisChart = (data, key1, key2, color1, color2, label1, label2) => {
    const validData = data.filter(d => (d[key1] !== null && d[key1] !== undefined) || (d[key2] !== null && d[key2] !== undefined));
    if (validData.length === 0) {
      return (
        <div style={{ height: '180px', display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--text-dim)', fontSize: '0.85rem' }}>
          Brak danych historycznych do wyrenderowania wykresu.
        </div>
      );
    }

    const width = 500;
    const height = 180;
    const padding = 35;

    const data1 = validData.filter(d => d[key1] !== null && d[key1] !== undefined);
    const data2 = validData.filter(d => d[key2] !== null && d[key2] !== undefined);

    const { min: min1, max: max1 } = getMinMax(data1, key1);
    const { min: min2, max: max2 } = getMinMax(data2, key2);

    const points1 = data1.map((d, index) => {
      const x = padding + (index / (data1.length - 1 || 1)) * (width - 2 * padding);
      const y = height - padding - ((d[key1] - min1) / (max1 - min1 || 1)) * (height - 2 * padding);
      return { x, y, val: d[key1], date: d.date };
    });

    const points2 = data2.map((d, index) => {
      const x = padding + (index / (data2.length - 1 || 1)) * (width - 2 * padding);
      const y = height - padding - ((d[key2] - min2) / (max2 - min2 || 1)) * (height - 2 * padding);
      return { x, y, val: d[key2], date: d.date };
    });

    const dPath1 = points1.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    const dPath2 = points2.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', fontSize: '0.8rem', marginBottom: '8px' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '12px', height: '3px', background: color1, borderRadius: '2px', display: 'inline-block' }}></span>
            <span style={{ color: 'var(--text-muted)' }}>{label1} (kg)</span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '12px', height: '3px', background: color2, borderRadius: '2px', display: 'inline-block' }}></span>
            <span style={{ color: 'var(--text-muted)' }}>{label2} (%)</span>
          </span>
        </div>
        <svg width="100%" height="180" viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
          {/* Grid lines */}
          <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="rgba(255,255,255,0.03)" />
          <line x1={padding} y1={(height) / 2} x2={width - padding} y2={(height) / 2} stroke="rgba(255,255,255,0.03)" />
          <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="rgba(255,255,255,0.08)" />

          {/* Left Y labels */}
          {data1.length > 0 && (
            <>
              <text x={padding - 8} y={padding + 4} fill={color1} fontSize="9" textAnchor="end" fontWeight="bold">{max1.toFixed(1)}</text>
              <text x={padding - 8} y={height - padding + 4} fill={color1} fontSize="9" textAnchor="end" fontWeight="bold">{min1.toFixed(1)}</text>
            </>
          )}

          {/* Right Y labels */}
          {data2.length > 0 && (
            <>
              <text x={width - padding + 8} y={padding + 4} fill={color2} fontSize="9" textAnchor="start" fontWeight="bold">{max2.toFixed(1)}%</text>
              <text x={width - padding + 8} y={height - padding + 4} fill={color2} fontSize="9" textAnchor="start" fontWeight="bold">{min2.toFixed(1)}%</text>
            </>
          )}

          {/* Line 1 */}
          {points1.length > 0 && (
            <path d={dPath1} fill="none" stroke={color1} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          )}
          {/* Line 2 */}
          {points2.length > 0 && (
            <path d={dPath2} fill="none" stroke={color2} strokeWidth="2" strokeDasharray="3 3" strokeLinecap="round" strokeLinejoin="round" />
          )}

          {/* Points 1 */}
          {points1.map((p, i) => (
            <circle key={`p1-${i}`} cx={p.x} cy={p.y} r="4" fill={color1} stroke="#0f111a" strokeWidth="2" />
          ))}

          {/* Points 2 */}
          {points2.map((p, i) => (
            <circle key={`p2-${i}`} cx={p.x} cy={p.y} r="3.5" fill={color2} stroke="#0f111a" strokeWidth="1.5" />
          ))}

          {/* X axis dates */}
          {validData.filter((_, i) => i === 0 || i === validData.length - 1 || (validData.length > 5 && i === Math.floor(validData.length / 2))).map((p, i) => {
            const x = padding + (validData.indexOf(p) / (validData.length - 1 || 1)) * (width - 2 * padding);
            return (
              <text key={`x-${i}`} x={x} y={height - 10} fill="var(--text-dim)" fontSize="9" textAnchor="middle">
                {p.date.slice(5)}
              </text>
            );
          })}
        </svg>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      
      {/* 1. Kafelki wskaźników z sensorów (Gotowość, Sen, Skład Ciała) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
        
        {/* Oura Ring: Sen i Gotowość */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '10px' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>💍</span> Oura Ring Status
            </h3>
            <span style={{ fontSize: '0.8rem', padding: '2px 8px', borderRadius: '12px', background: userProfile?.has_oura ? 'rgba(52, 211, 153, 0.15)' : 'rgba(239, 68, 68, 0.15)', color: userProfile?.has_oura ? '#34d399' : '#f87171' }}>
              {userProfile?.has_oura ? 'Połączono' : 'Rozłączono'}
            </span>
          </div>

          {!userProfile?.has_oura ? (
            <div style={{ textAlign: 'center', padding: '20px 10px', color: 'var(--text-dim)', fontSize: '0.9rem' }}>
              Brak połączenia z kontem Oura Ring. Skonfiguruj integrację w zakładce Ustawienia.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.03)' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)', display: 'block' }}>Gotowość (Readiness)</span>
                  <strong style={{ fontSize: '1.4rem', color: '#c084fc' }}>
                    {summary.readiness_score !== null ? `${summary.readiness_score}/100` : '--'}
                  </strong>
                </div>
                <div style={{ background: 'rgba(255,255,255,0.02)', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.03)' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)', display: 'block' }}>Wynik Snu (Sleep)</span>
                  <strong style={{ fontSize: '1.4rem', color: '#38bdf8' }}>
                    {summary.sleep_score !== null ? `${summary.sleep_score}/100` : '--'}
                  </strong>
                </div>
              </div>

              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Długość snu:</span>
                  <span style={{ color: '#fff', fontWeight: 600 }}>
                    {summary.sleep_duration !== null ? `${summary.sleep_duration.toFixed(1)}h` : '--'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Faza głęboka / REM:</span>
                  <span style={{ color: '#fff', fontWeight: 600 }}>
                    {summary.sleep_deep !== null ? `${summary.sleep_deep.toFixed(1)}h` : '--'} / {summary.sleep_rem !== null ? `${summary.sleep_rem.toFixed(1)}h` : '--'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>HRV (Zmienność tętna):</span>
                  <span style={{ color: '#fff', fontWeight: 600 }}>
                    {summary.hrv !== null ? `${summary.hrv.toFixed(0)} ms` : '--'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Tętno spoczynkowe (RHR):</span>
                  <span style={{ color: '#fff', fontWeight: 600 }}>
                    {summary.rhr !== null ? `${summary.rhr.toFixed(0)} bpm` : '--'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Odchylenie temperatury:</span>
                  <span style={{ color: summary.temperature_deviation > 0 ? '#f87171' : '#34d399', fontWeight: 600 }}>
                    {summary.temperature_deviation !== null ? `${summary.temperature_deviation > 0 ? '+' : ''}${summary.temperature_deviation.toFixed(2)} °C` : '--'}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Withings: Skład Ciała i Waga */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '10px' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>⚖️</span> Withings Status
            </h3>
            <span style={{ fontSize: '0.8rem', padding: '2px 8px', borderRadius: '12px', background: userProfile?.has_withings ? 'rgba(52, 211, 153, 0.15)' : 'rgba(239, 68, 68, 0.15)', color: userProfile?.has_withings ? '#34d399' : '#f87171' }}>
              {userProfile?.has_withings ? 'Połączono' : 'Rozłączono'}
            </span>
          </div>

          {!userProfile?.has_withings ? (
            <div style={{ textAlign: 'center', padding: '20px 10px', color: 'var(--text-dim)', fontSize: '0.9rem' }}>
              Brak połączenia z kontem Withings. Skonfiguruj integrację w zakładce Ustawienia.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '12px' }}>
                <div style={{ background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.03)', textAlign: 'center' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)', display: 'block' }}>Aktualna Waga Ciała</span>
                  <strong style={{ fontSize: '1.8rem', color: '#fbbf24' }}>
                    {summary.weight !== null ? `${summary.weight.toFixed(1)} kg` : '--'}
                  </strong>
                </div>
              </div>

              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Procent tkanki tłuszczowej (Fat %):</span>
                  <span style={{ color: '#fff', fontWeight: 600 }}>
                    {summary.fat_ratio !== null ? `${summary.fat_ratio.toFixed(1)}%` : '--'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Szacowana masa tłuszczu:</span>
                  <span style={{ color: '#fff', fontWeight: 600 }}>
                    {summary.weight !== null && summary.fat_ratio !== null ? `${((summary.weight * summary.fat_ratio) / 100).toFixed(1)} kg` : '--'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Masa mięśniowa (Muscle mass):</span>
                  <span style={{ color: '#34d399', fontWeight: 600 }}>
                    {summary.muscle_mass !== null ? `${summary.muscle_mass.toFixed(1)} kg` : '--'}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Ogólna Aktywność: Kroki i Kalorie */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '10px' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>👣</span> Dzisiejsza Aktywność
            </h3>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>Importowane</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '1.2rem' }}>👣</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Kroki</div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>Wykonane dzisiaj</span>
                </div>
              </div>
              <strong style={{ fontSize: '1.1rem', color: '#fff' }}>
                {summary.steps ? summary.steps.toLocaleString('pl-PL') : '0'}
              </strong>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '1.2rem' }}>🔥</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Aktywne Kalorie</div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>Spalone w ruchu</span>
                </div>
              </div>
              <strong style={{ fontSize: '1.1rem', color: 'var(--color-secondary)' }}>
                {summary.calories_burned_active ? `${summary.calories_burned_active} kcal` : '0 kcal'}
              </strong>
            </div>

            <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '10px', fontSize: '0.8rem', color: 'var(--text-dim)', textAlign: 'right' }}>
              Ost. sync: {formatSyncTime(summary.last_sync)}
            </div>
          </div>
        </div>

        {/* Cele Aktywności */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '10px' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>🎯</span> Cele Aktywności
            </h3>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>Ustawienia celów</span>
          </div>

          <form onSubmit={handleSaveGoals} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>Kroki (kroki)</label>
              <input
                type="number"
                className="input-field"
                style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                value={goals.target_steps}
                onChange={(e) => setGoals({...goals, target_steps: Number(e.target.value)})}
                min="0"
                required
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>Aktywne kalorie (kcal)</label>
              <input
                type="number"
                className="input-field"
                style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                value={goals.target_active_calories}
                onChange={(e) => setGoals({...goals, target_active_calories: Number(e.target.value)})}
                min="0"
                required
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>Czas snu (godziny)</label>
              <input
                type="number"
                step="0.1"
                className="input-field"
                style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                value={goals.target_sleep_duration}
                onChange={(e) => setGoals({...goals, target_sleep_duration: Number(e.target.value)})}
                min="0"
                required
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>Minuty ćwiczeń (min)</label>
              <input
                type="number"
                className="input-field"
                style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                value={goals.target_active_minutes}
                onChange={(e) => setGoals({...goals, target_active_minutes: Number(e.target.value)})}
                min="0"
                required
              />
            </div>
            <button type="submit" className="btn-primary" style={{ padding: '6px 12px', fontSize: '0.85rem', marginTop: '6px', height: '34px' }} disabled={isSavingGoals}>
              {isSavingGoals ? 'Zapisywanie...' : 'Zapisz cele'}
            </button>
            {goalsMessage.text && (
              <div style={{ fontSize: '0.8rem', color: goalsMessage.type === 'success' ? '#34d399' : '#f87171', textAlign: 'center', marginTop: '4px' }}>
                {goalsMessage.text}
              </div>
            )}
          </form>
        </div>
      </div>

      {/* 2. Wykresy trendów z 30 dni (Spalanie Tłuszczu i Masa Mięśniowa) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '24px', marginTop: '10px' }}>
        
        {/* Wykres 1: Spalanie Tłuszczu (Waga i Fat %) */}
        <div className="glass-card">
          <h3 className="card-title" style={{ marginBottom: '4px' }}>📉 Wykres 1: Spalanie Tłuszczu</h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '16px' }}>
            Zależność wagi ciała w kg (linia ciągła) do procentu tkanki tłuszczowej (linia przerywana).
          </p>
          {isLoadingHistory ? (
            <div style={{ height: '180px', display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--text-dim)' }}>
              Ładowanie wykresu...
            </div>
          ) : (
            renderDualAxisChart(historyData, 'weight', 'fat_ratio', '#38bdf8', '#fbbf24', 'Waga ciała', 'Tkanka tłuszczowa')
          )}
        </div>

        {/* Wykres 2: Przyrost Mięśni (Masa mięśniowa w kg) */}
        <div className="glass-card">
          <h3 className="card-title" style={{ marginBottom: '4px' }}>📈 Wykres 2: Rozwój Masy Mięśniowej</h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '16px' }}>
            Trend beztłuszczowej masy mięśniowej w kg z ostatnich 30 dni.
          </p>
          {isLoadingHistory ? (
            <div style={{ height: '180px', display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--text-dim)' }}>
              Ładowanie wykresu...
            </div>
          ) : (
            renderLineChart(historyData, 'muscle_mass', '#34d399', 'Masa mięśniowa (kg)')
          )}
        </div>

      </div>

      {/* 3. Pomiary Obwodów Ciała */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '24px', marginTop: '10px' }}>
        
        {/* Formularz wprowadzania pomiarów i Wykres trendu obwodów */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h3 className="card-title">📐 Pomiary Obwodów Ciała</h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>
            Wprowadzaj regularnie pomiary obwodów swojego ciała, aby monitorować rozwój sylwetki.
          </p>
          
          <form onSubmit={handleSaveMeasurement} style={{ display: 'flex', flexDirection: 'column', gap: '12px', background: 'rgba(255,255,255,0.01)', padding: '12px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.03)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>Data</label>
                <input
                  type="date"
                  name="date"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.date}
                  onChange={handleFormMeasurementChange}
                  required
                />
              </div>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>Talia / Pas (cm)</label>
                <input
                  type="number"
                  step="0.1"
                  name="waist"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.waist}
                  onChange={handleFormMeasurementChange}
                  placeholder="np. 85"
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>Klatka (cm)</label>
                <input
                  type="number"
                  step="0.1"
                  name="chest"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.chest}
                  onChange={handleFormMeasurementChange}
                  placeholder="np. 100"
                />
              </div>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>Biodra (cm)</label>
                <input
                  type="number"
                  step="0.1"
                  name="hips"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.hips}
                  onChange={handleFormMeasurementChange}
                  placeholder="np. 95"
                />
              </div>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>Biceps (cm)</label>
                <input
                  type="number"
                  step="0.1"
                  name="biceps"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.biceps}
                  onChange={handleFormMeasurementChange}
                  placeholder="np. 37"
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '12px', alignItems: 'flex-end' }}>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label" style={{ fontSize: '0.75rem' }}>Udo (cm)</label>
                <input
                  type="number"
                  step="0.1"
                  name="thigh"
                  className="input-field"
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  value={formMeasurement.thigh}
                  onChange={handleFormMeasurementChange}
                  placeholder="np. 55"
                />
              </div>
              <button type="submit" className="btn-primary" style={{ padding: '8px 12px', fontSize: '0.85rem', height: '38px' }} disabled={isSavingMeasurement}>
                {isSavingMeasurement ? 'Zapisywanie...' : 'Zapisz pomiar'}
              </button>
            </div>
            {measurementMessage.text && (
              <div style={{ fontSize: '0.8rem', color: measurementMessage.type === 'success' ? '#34d399' : '#f87171', marginTop: '4px' }}>
                {measurementMessage.text}
              </div>
            )}
          </form>

          {/* Wykres trendu obwodów */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
              <strong style={{ fontSize: '0.9rem', color: '#fff' }}>📉 Wykres Trendów Obwodów</strong>
              <select
                className="input-field"
                style={{ width: 'auto', padding: '4px 10px', fontSize: '0.8rem', height: '30px', background: 'var(--bg-glass)', border: '1px solid var(--border-glass)', borderRadius: '6px', color: '#fff' }}
                value={selectedMeasure}
                onChange={(e) => setSelectedMeasure(e.target.value)}
              >
                <option value="waist">Talia / Pas</option>
                <option value="chest">Klatka piersiowa</option>
                <option value="hips">Biodra</option>
                <option value="biceps">Biceps</option>
                <option value="thigh">Udo</option>
              </select>
            </div>
            {isLoadingMeasurements ? (
              <div style={{ height: '180px', display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--text-dim)' }}>
                Ładowanie wykresu...
              </div>
            ) : (
              renderLineChart(measurementsData, selectedMeasure, '#c084fc', getMeasureLabel(selectedMeasure))
            )}
          </div>
        </div>

        {/* Historia pomiarów obwodów */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h3 className="card-title">📜 Historia Pomiarów Obwodów</h3>
          {isLoadingMeasurements ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '20px', color: 'var(--text-dim)' }}>
              Ładowanie historii...
            </div>
          ) : measurementsData.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 10px', color: 'var(--text-dim)', fontSize: '0.9rem' }}>
              Brak wprowadzonych pomiarów ciała. Zaloguj swój pierwszy pomiar obok!
            </div>
          ) : (
            <div style={{ overflowX: 'auto', maxHeight: '400px', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-dim)' }}>
                    <th style={{ padding: '8px 4px' }}>Data</th>
                    <th style={{ padding: '8px 4px' }}>Talia</th>
                    <th style={{ padding: '8px 4px' }}>Klatka</th>
                    <th style={{ padding: '8px 4px' }}>Biodra</th>
                    <th style={{ padding: '8px 4px' }}>Bic</th>
                    <th style={{ padding: '8px 4px' }}>Udo</th>
                    <th style={{ padding: '8px 4px', textAlign: 'center' }}>Akcje</th>
                  </tr>
                </thead>
                <tbody>
                  {[...measurementsData].reverse().map((m) => (
                    <tr key={m.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', color: 'var(--text-muted)' }}>
                      <td style={{ padding: '8px 4px', fontWeight: 600, color: '#fff' }}>{m.date}</td>
                      <td style={{ padding: '8px 4px' }}>{m.waist ? `${m.waist} cm` : '--'}</td>
                      <td style={{ padding: '8px 4px' }}>{m.chest ? `${m.chest} cm` : '--'}</td>
                      <td style={{ padding: '8px 4px' }}>{m.hips ? `${m.hips} cm` : '--'}</td>
                      <td style={{ padding: '8px 4px' }}>{m.biceps ? `${m.biceps} cm` : '--'}</td>
                      <td style={{ padding: '8px 4px' }}>{m.thigh ? `${m.thigh} cm` : '--'}</td>
                      <td style={{ padding: '8px 4px', textAlign: 'center' }}>
                        <button
                          type="button"
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#f87171',
                            cursor: 'pointer',
                            padding: '4px',
                            fontSize: '1rem'
                          }}
                          onClick={() => handleDeleteMeasurement(m.id)}
                          title="Usuń pomiar"
                        >
                          🗑️
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>

    </div>
  );
}
