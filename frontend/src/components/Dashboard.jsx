import React, { useState, useEffect, useRef } from 'react';

// Progress Circle Helper Component (SVG)
const RenderProgressCircle = ({ size = 80, strokeWidth = 6, percentage = 0, color = "#7c3aed" }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.min(Math.max(percentage, 0), 100) / 100) * circumference;
  
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      {/* Background Track */}
      <circle
        stroke="rgba(255, 255, 255, 0.05)"
        fill="transparent"
        strokeWidth={strokeWidth}
        r={radius}
        cx={size / 2}
        cy={size / 2}
      />
      {/* Progress Line */}
      <circle
        stroke={color}
        fill="transparent"
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        r={radius}
        cx={size / 2}
        cy={size / 2}
        style={{ transition: 'stroke-dashoffset 0.8s ease-in-out' }}
      />
    </svg>
  );
};

// Sleep Stage Horizontal Bar with range brackets
const SleepStageBar = ({ label, durationText, percentage, typicalStart, typicalEnd, colorClass }) => {
  return (
    <div className="sleep-stage-row">
      <div className="sleep-stage-header">
        <span style={{ color: 'rgba(255, 255, 255, 0.6)', fontSize: '0.8rem' }}>{label}</span>
        <span style={{ fontWeight: '700', fontSize: '0.85rem' }}>{durationText}</span>
      </div>
      <div className="sleep-stage-bar-container">
        <div className="sleep-stage-bar-bg"></div>
        {/* Typical Range Bracket */}
        <div 
          className="sleep-stage-typical-bracket" 
          style={{ left: `${typicalStart}%`, width: `${typicalEnd - typicalStart}%` }}
          title="Typowy zakres"
        ></div>
        {/* Fill Bar */}
        <div 
          className={`sleep-stage-bar-fill ${colorClass}`} 
          style={{ width: `${percentage}%` }}
        ></div>
      </div>
    </div>
  );
};

// Micro Sparkline Generator (SVG)
const renderSparkline = (dataPoints) => {
  if (!dataPoints || dataPoints.length === 0) return null;
  const width = 80;
  const height = 18;
  const min = Math.min(...dataPoints);
  const max = Math.max(...dataPoints);
  const range = max - min || 1;
  
  const points = dataPoints.map((val, idx) => {
    const x = (idx / (dataPoints.length - 1)) * width;
    const y = height - ((val - min) / range) * height;
    return `${x},${y}`;
  }).join(' ');
  
  return (
    <svg width={width} height={height}>
      <polyline
        fill="none"
        stroke="#10b981"
        strokeWidth="1.5"
        points={points}
      />
    </svg>
  );
};

const getWorkoutIcon = (type) => {
  const t = type.toLowerCase();
  if (t.includes('run') || t.includes('bieg')) return '🏃';
  if (t.includes('walk') || t.includes('spacer') || t.includes('marsz')) return '🚶';
  if (t.includes('cycle') || t.includes('rower')) return '🚴';
  if (t.includes('swim') || t.includes('pływ')) return '🏊';
  if (t.includes('strength') || t.includes('siłownia') || t.includes('ciężar')) return '🏋️';
  if (t.includes('cardio') || t.includes('aerob')) return '⚡';
  if (t.includes('yoga') || t.includes('joga')) return '🧘';
  return '💪';
};

// Daily Goal grid cell
const DailyGoalCard = ({ title, val1, unit1, val2, unit2, percentage, barType }) => {
  return (
    <div className="daily-goal-card">
      <div className="daily-goal-title">{title}</div>
      <div className="daily-goal-value-row">
        <span className="daily-goal-value">{val1}</span>
        <span className="daily-goal-unit" style={{ marginRight: val2 ? '6px' : '0' }}>{unit1}</span>
        {val2 && (
          <>
            <span className="daily-goal-value">{val2}</span>
            <span className="daily-goal-unit">{unit2}</span>
          </>
        )}
      </div>
      <div className="daily-goal-progress-container">
        <div className="daily-goal-progress-track">
          <div 
            className={`daily-goal-progress-fill ${barType}`} 
            style={{ width: `${percentage}%` }}
          ></div>
        </div>
        <div className="daily-goal-pct">{percentage}%</div>
      </div>
    </div>
  );
};

// Trend range 3-segment bar
const TrendRangeBar = ({ activeSegment, color }) => {
  const getSegmentClass = (seg) => {
    if (activeSegment !== seg) return 'trend-range-segment';
    return `trend-range-segment active-${color}`;
  };
  
  return (
    <div className="trend-range-bar">
      <div className={getSegmentClass('left')}>
        {activeSegment === 'left' && <div className="trend-range-knob"></div>}
      </div>
      <div className={getSegmentClass('middle')}>
        {activeSegment === 'middle' && <div className="trend-range-knob"></div>}
      </div>
      <div className={getSegmentClass('right')}>
        {activeSegment === 'right' && <div className="trend-range-knob"></div>}
      </div>
    </div>
  );
};

// Trend cell component
const TrendCard = ({ title, valueText, unitText, activeSegment, color, footerText, status }) => {
  return (
    <div className="trend-health-card">
      <div className="trend-health-title">{title}</div>
      <div className="trend-health-value-row">
        <span className="trend-health-value">{valueText}</span>
        <span className="trend-health-unit">{unitText}</span>
      </div>
      <TrendRangeBar activeSegment={activeSegment} color={color} />
      <div className={`trend-health-footer ${status}`}>
        <span style={{ fontSize: '0.85rem', marginRight: '4px' }}>
          {status === 'success' ? '✓' : '⚠️'}
        </span> 
        {footerText}
      </div>
    </div>
  );
};

export default function Dashboard({ summary, aiAdvice, sessionToken, selectedDate, onNavigate }) {
  const [historyData, setHistoryData] = useState([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

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
        console.error('Błąd pobierania historii:', err);
      } finally {
        setIsLoadingHistory(false);
      }
    };
    fetchHistory();
  }, [sessionToken, summary.last_sync]);

  const renderWeightCompositionChart = (data) => {
    let validData = data.filter(d => 
      (d.weight !== null && d.weight !== undefined) || 
      (d.fat_ratio !== null && d.fat_ratio !== undefined) ||
      (d.muscle_mass !== null && d.muscle_mass !== undefined)
    );

    let isMock = false;
    if (validData.length === 0) {
      isMock = true;
      const baseW = weight || 79.5;
      const baseF = fatRatio || 15.2;
      const baseM = muscleMass || 64.3;
      validData = Array.from({ length: 7 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (6 - i));
        // Subtle oscillations to simulate progress
        const wOffset = Math.sin(i * 0.8) * 0.6 - (i * 0.1);
        const fOffset = Math.cos(i * 0.8) * 0.3 - (i * 0.05);
        const mOffset = Math.sin(i * 0.8 + 1) * 0.2 + (i * 0.05);
        return {
          date: d.toISOString().split('T')[0],
          weight: Math.round((baseW + wOffset) * 10) / 10,
          fat_ratio: Math.round((baseF + fOffset) * 10) / 10,
          muscle_mass: Math.round((baseM + mOffset) * 10) / 10
        };
      });
    } else if (validData.length === 1) {
      const single = validData[0];
      const prevDate = new Date(single.date);
      prevDate.setDate(prevDate.getDate() - 1);
      validData = [
        { ...single, date: prevDate.toISOString().split('T')[0] },
        single
      ];
    }

    const width = 500;
    const height = 110;
    const paddingLeft = 30;
    const paddingRight = 30;
    const paddingTop = 15;
    const paddingBottom = 15;

    const getCompositionMinMax = (arr, key) => {
      const values = arr.map(d => d[key]).filter(v => v !== null && v !== undefined);
      if (values.length === 0) return { min: 0, max: 100 };
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = max - min;
      const padding = range === 0 ? 5 : range * 0.15;
      return { min: Math.max(0, min - padding), max: max + padding };
    };

    const weightsAndMuscles = validData.reduce((acc, d) => {
      if (d.weight !== null && d.weight !== undefined) acc.push(d.weight);
      if (d.muscle_mass !== null && d.muscle_mass !== undefined) acc.push(d.muscle_mass);
      return acc;
    }, []);
    const minLeft = weightsAndMuscles.length ? Math.max(0, Math.min(...weightsAndMuscles) - 5) : 50;
    const maxLeft = weightsAndMuscles.length ? Math.max(...weightsAndMuscles) + 5 : 100;

    const { min: minRight, max: maxRight } = getCompositionMinMax(validData, 'fat_ratio');

    const pointsWeight = [];
    const pointsMuscle = [];
    const pointsFat = [];

    validData.forEach((d, index) => {
      const x = paddingLeft + (index / (validData.length - 1 || 1)) * (width - paddingLeft - paddingRight);
      
      if (d.weight !== null && d.weight !== undefined) {
        const y = height - paddingBottom - ((d.weight - minLeft) / (maxLeft - minLeft || 1)) * (height - paddingTop - paddingBottom);
        pointsWeight.push({ x, y });
      }
      if (d.muscle_mass !== null && d.muscle_mass !== undefined) {
        const y = height - paddingBottom - ((d.muscle_mass - minLeft) / (maxLeft - minLeft || 1)) * (height - paddingTop - paddingBottom);
        pointsMuscle.push({ x, y });
      }
      if (d.fat_ratio !== null && d.fat_ratio !== undefined) {
        const y = height - paddingBottom - ((d.fat_ratio - minRight) / (maxRight - minRight || 1)) * (height - paddingTop - paddingBottom);
        pointsFat.push({ x, y });
      }
    });

    const dWeight = pointsWeight.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    const dMuscle = pointsMuscle.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    const dFat = pointsFat.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '10px', marginTop: '10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>
          <span>📈 Trend składu ciała {isMock ? '(Dane demonstracyjne)' : '(30 dni)'}</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
              <span style={{ width: '6px', height: '6px', background: '#38bdf8', borderRadius: '50%' }}></span> Waga
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
              <span style={{ width: '6px', height: '6px', background: '#34d399', borderRadius: '50%' }}></span> Mięśnie
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
              <span style={{ width: '6px', height: '6px', background: '#fbbf24', borderRadius: '50%' }}></span> Tłuszcz %
            </span>
          </div>
        </div>
        <div style={{ position: 'relative' }}>
          <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
            <line x1={paddingLeft} y1={paddingTop} x2={width - paddingRight} y2={paddingTop} stroke="rgba(255,255,255,0.02)" />
            <line x1={paddingLeft} y1={height / 2} x2={width - paddingRight} y2={height / 2} stroke="rgba(255,255,255,0.02)" />
            <line x1={paddingLeft} y1={height - paddingBottom} x2={width - paddingRight} y2={height - paddingBottom} stroke="rgba(255,255,255,0.05)" />

            <text x={paddingLeft - 4} y={paddingTop + 3} fill="rgba(255,255,255,0.3)" fontSize="8" textAnchor="end">{Math.round(maxLeft)}</text>
            <text x={paddingLeft - 4} y={height - paddingBottom + 3} fill="rgba(255,255,255,0.3)" fontSize="8" textAnchor="end">{Math.round(minLeft)}</text>

            <text x={width - paddingRight + 4} y={paddingTop + 3} fill="rgba(255,255,255,0.3)" fontSize="8" textAnchor="start">{Math.round(maxRight)}%</text>
            <text x={width - paddingRight + 4} y={height - paddingBottom + 3} fill="rgba(255,255,255,0.3)" fontSize="8" textAnchor="start">{Math.round(minRight)}%</text>

            {dWeight && <path d={dWeight} fill="none" stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round" />}
            {dMuscle && <path d={dMuscle} fill="none" stroke="#34d399" strokeWidth="1.5" strokeLinecap="round" />}
            {dFat && <path d={dFat} fill="none" stroke="#fbbf24" strokeWidth="1.5" strokeDasharray="3,3" strokeLinecap="round" />}
          </svg>
        </div>
      </div>
    );
  };

  // 1. DANE RZECZYWISTE LUB REALISTYCZNE FALLBACKI (zgodne ze zrzutami ekranu)
  const isDemo = !summary.sleep_score && !summary.readiness_score;
  
  const sleepScore = summary.sleep_score !== null && summary.sleep_score !== undefined ? summary.sleep_score : (isDemo ? 85 : 0);
  const readinessScore = summary.readiness_score !== null && summary.readiness_score !== undefined ? summary.readiness_score : (isDemo ? 79 : 0);
  
  const steps = isDemo ? (summary.steps || 1347) : (summary.steps || 0);
  const activeCalories = isDemo ? (summary.calories_burned_active || 539) : (summary.calories_burned_active || 0);
  const effortScore = activeCalories > 0 ? Math.round(Math.min((activeCalories / 800) * 100, 100)) : (isDemo ? 67 : 0);
  const activeMinutes = isDemo ? (summary.active_minutes || 45) : (summary.active_minutes || 0);
  
  const sleepDurationHours = summary.sleep_duration !== null && summary.sleep_duration !== undefined ? summary.sleep_duration : (isDemo ? 7.91 : 0);
  const sleepDeepHours = summary.sleep_deep !== null && summary.sleep_deep !== undefined ? summary.sleep_deep : (isDemo ? 1.35 : 0);
  const sleepRemHours = summary.sleep_rem !== null && summary.sleep_rem !== undefined ? summary.sleep_rem : (isDemo ? 1.98 : 0);
  const sleepAwakeMins = isDemo ? 37 : 0;
  const sleepLightHours = Math.max(sleepDurationHours - sleepDeepHours - sleepRemHours - (sleepAwakeMins / 60), 0) || (isDemo ? 3.96 : 0);
  
  const rhr = summary.rhr || (isDemo ? 54 : 0);
  const hrv = summary.hrv || (isDemo ? 48 : 0);
  
  const weight = summary.weight !== null && summary.weight !== undefined ? summary.weight : (isDemo ? 79.5 : 0);
  const fatRatio = summary.fat_ratio !== null && summary.fat_ratio !== undefined ? summary.fat_ratio : (isDemo ? 15.2 : 0);
  const muscleMass = summary.muscle_mass !== null && summary.muscle_mass !== undefined ? summary.muscle_mass : (isDemo ? 64.3 : 0);

  // Kalkulacja stref tętna (Karvonen) na bazie RHR z Oura
  const userMaxHr = 190; // Domyślny Max HR (odpowiednik wieku ~30 lat)
  const hrReserve = userMaxHr - rhr;
  const hrZone1Min = Math.round(hrReserve * 0.5 + rhr);
  const hrZone1Max = Math.round(hrReserve * 0.6 + rhr);
  const hrZone2Min = Math.round(hrReserve * 0.6 + rhr);
  const hrZone2Max = Math.round(hrReserve * 0.7 + rhr);
  const hrZone3Min = Math.round(hrReserve * 0.7 + rhr);
  const hrZone3Max = Math.round(hrReserve * 0.8 + rhr);
  const hrZone4Min = Math.round(hrReserve * 0.8 + rhr);
  const hrZone4Max = Math.round(hrReserve * 0.9 + rhr);
  const hrZone5Min = Math.round(hrReserve * 0.9 + rhr);
  
  // Odżywianie
  const targetCalories = summary.target_calories || 2000;
  const eatenCalories = summary.calories_eaten || 0;
  const targetProtein = summary.target_protein || 150;
  const targetCarbs = summary.target_carbs || 250;
  const targetFat = summary.target_fat || 80;
  const eatenProtein = summary.eaten_protein || 0;
  const eatenCarbs = summary.eaten_carbs || 0;
  const eatenFat = summary.eaten_fat || 0;

  // Cel obciążenia (Athlytic/WHOOP style)
  // Wyznacza przedział docelowy w oparciu o readiness
  const loadGoalMin = Math.round(readinessScore * 0.4);
  const loadGoalMax = Math.round(readinessScore * 0.65);
  // Aktualne obciążenie na suwaku (np. wysiłek)
  const currentLoadPos = Math.max(Math.min(effortScore, 100), 5); // min 5% dla widoczności suwaka
  
  // Bateria body battery
  const batteryPct = Math.round(Math.min(Math.max(readinessScore + 18, 50), 99));
  
  // Lista ostatnich aktywności (zrzuty ekranu)
  const demoActivities = [
    { type: 'Chodzenie na zewnątrz', dateLabel: 'niedziela', duration: '15 min', calories: 63 },
    { type: 'inne', dateLabel: 'niedziela', duration: '2godz 0min', calories: 2999 },
    { type: 'Chodzenie na zewnątrz', dateLabel: 'piątek', duration: '12 min', calories: 54 }
  ];
  
  const activities = (summary.workouts && summary.workouts.length > 0) 
    ? summary.workouts.map(w => ({
        type: w.type,
        dateLabel: 'dzisiaj',
        duration: `${w.duration_mins} min`,
        calories: w.calories
      }))
    : demoActivities;

  // Stany dla wbudowanego czatu z asystentem Dietetyk AI
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState([
    { sender: 'ai', text: 'Cześć! Jestem Twoim inteligentnym asystentem w aplikacji Dietetyk AI. Przeanalizowałem Twoje dzisiejsze wyniki gotowości (Readiness), snu oraz treningów. W czym mogę Ci pomóc w kontekście diety lub obciążenia treningowego?' }
  ]);
  const [isSendingChat, setIsSendingChat] = useState(false);
  
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isChatOpen]);

  const handleSendChat = async (e) => {
    e.preventDefault();
    if (!chatInput.trim() || isSendingChat) return;
    
    const userMsg = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { sender: 'user', text: userMsg }]);
    setIsSendingChat(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ message: userMsg, date: selectedDate, history: chatMessages })
      });
      
      if (res.ok) {
        const data = await res.json();
        setChatMessages(prev => [...prev, { sender: 'ai', text: data.response }]);
      } else {
        setChatMessages(prev => [...prev, { sender: 'ai', text: 'Przepraszam, wystąpił problem z połączeniem. Upewnij się, że masz skonfigurowany Gemini API Key w Ustawieniach.' }]);
      }
    } catch (err) {
      setChatMessages(prev => [...prev, { sender: 'ai', text: 'Błąd sieciowy. Nie można połączyć się z asystentem Dietetyk AI.' }]);
    } finally {
      setIsSendingChat(false);
    }
  };

  // Formatowanie minut do godzin/minut
  const formatHoursMins = (hoursDecimal) => {
    const hours = Math.floor(hoursDecimal);
    const mins = Math.round((hoursDecimal - hours) * 60);
    return `${hours}h ${mins}m`;
  };

  // Sparkline data (simulated stress curve over the day)
  const stressPoints = [12, 14, 11, 15, 23, 29, 21, 16, 12, 8, 4, 9, 14, 15, 17, 20];

  return (
    <div className="premium-dashboard-container">
      
      {/* NAGŁÓWEK REGENERACJI AI */}
      <div className="dietetyk-ai-banner">
        <div className="premium-title-row">
          <span className="dietetyk-greeting">
            {readinessScore >= 80 
              ? "Dzisiaj wyglądasz na gotowego na pełne obciążenie" 
              : "Dzisiaj wyglądasz na gotowego do lżejszej pracy"
            }
          </span>
          {isDemo && <span style={{ fontSize: '0.65rem', background: 'rgba(255,255,255,0.08)', padding: '2px 6px', borderRadius: '4px', color: 'rgba(255,255,255,0.5)' }}>DEMO DATA</span>}
        </div>
        <p className="dietetyk-ai-advice-text">
          {aiAdvice && aiAdvice.length > 30 
            ? aiAdvice 
            : `Twoja regeneracja trzyma stabilny poziom (${readinessScore}%). HRV wynosi ${hrv} ms i mieści się w normie, więc organizm nie protestuje przeciwko aktywności. Dobrym wyborem będzie lekki tlenowy wysiłek kardio lub sesja mobility.`
          }
        </p>
        <button className="btn-dietetyk-ask" onClick={() => setIsChatOpen(true)}>
          ✨ Zapytaj agenta
        </button>
      </div>

      {/* KOLUMNY DASHBOARDU DLA ZAPEWNIENIA MASONRY / BRAKU CZARNYCH PRZESTRZENI */}
      <div className="dashboard-column">
        {/* POTRÓJNE RINGI: SEN, REGENERACJA, WYSIŁEK */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">⚡ Regeneracja i Stan</span>
            <span className="premium-title-info">ⓘ</span>
          </div>
          
          <div className="ring-row">
            {/* Sen */}
            <div className="ring-item">
              <div style={{ position: 'relative', width: 84, height: 84, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <RenderProgressCircle size={84} strokeWidth={7} percentage={sleepScore} color="#38bdf8" />
                <div style={{ position: 'absolute', fontSize: '1.05rem', fontWeight: '800', color: '#fff' }}>
                  {sleepScore}%
                </div>
              </div>
              <span className="ring-item-label">🌙 Sen</span>
            </div>

            {/* Regeneracja */}
            <div className="ring-item">
              <div style={{ position: 'relative', width: 96, height: 96, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <RenderProgressCircle size={96} strokeWidth={8} percentage={readinessScore} color="#ffffff" />
                <div style={{ position: 'absolute', fontSize: '1.25rem', fontWeight: '800', color: '#fff' }}>
                  {readinessScore}%
                </div>
              </div>
              <span className="ring-item-label" style={{ fontWeight: '700', color: '#fff' }}>⚡ Regeneracja</span>
            </div>

            {/* Wysiłek */}
            <div className="ring-item">
              <div style={{ position: 'relative', width: 84, height: 84, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <RenderProgressCircle size={84} strokeWidth={7} percentage={effortScore} color={effortScore > 0 ? "#ef4444" : "rgba(255,255,255,0.08)"} />
                <div style={{ position: 'absolute', fontSize: '1.05rem', fontWeight: '800', color: '#fff' }}>
                  {effortScore}%
                </div>
              </div>
              <span className="ring-item-label">🔥 Wysiłek</span>
            </div>
          </div>
        </div>

        {/* CELE DZIENNE */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
          <div className="premium-title-row" style={{ padding: '0 4px' }}>
            <span className="premium-title" style={{ fontSize: '1.2rem' }}>Cele dzienne</span>
            <span 
              onClick={() => onNavigate && onNavigate('activity')} 
              style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}
            >
              Ustaw cele
            </span>
          </div>
          <div className="premium-grid-2">
            <DailyGoalCard 
              title="Kroki" 
              val1={steps.toLocaleString('pl-PL')} 
              unit1="kroki" 
              percentage={Math.min(Math.round((steps / (summary?.target_steps || 10000)) * 100), 100)} 
              barType={Math.min(Math.round((steps / (summary?.target_steps || 10000)) * 100), 100) < 30 ? "red" : "gradient"} 
            />
            <DailyGoalCard 
              title="Aktywne kalorie" 
              val1={String(activeCalories)} 
              unit1="kcal" 
              percentage={Math.min(Math.round((activeCalories / (summary?.target_active_calories || 500)) * 100), 100)} 
              barType="gradient" 
            />
            <DailyGoalCard 
              title="Czas snu" 
              val1={String(Math.floor(sleepDurationHours))} 
              unit1="godz" 
              val2={String(Math.round((sleepDurationHours - Math.floor(sleepDurationHours)) * 60))} 
              unit2="min" 
              percentage={Math.min(Math.round((sleepDurationHours / (summary?.target_sleep_duration || 7.2)) * 100), 100)} 
              barType="gradient" 
            />
            <DailyGoalCard 
              title="Minuty ćwiczeń" 
              val1={String(activeMinutes)} 
              unit1="min" 
              percentage={Math.min(Math.round((activeMinutes / (summary?.target_active_minutes || 30)) * 100), 100)} 
              barType={activeMinutes > 0 ? "gradient" : "grey"} 
            />
          </div>
        </div>

        {/* SEN DETAILS */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">Sen</span>
            <span className="premium-title-info">▶</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '24px', margin: '8px 0' }}>
            {/* Main sleep ring */}
            <div style={{ position: 'relative', width: 104, height: 104, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <RenderProgressCircle size={104} strokeWidth={8} percentage={sleepScore} color="#3b82f6" />
              <div style={{ position: 'absolute', textAlign: 'center' }}>
                <div style={{ fontSize: '1.2rem', fontWeight: '800', color: '#fff', lineHeight: 1 }}>
                  {formatHoursMins(sleepDurationHours)}
                </div>
                <div style={{ fontSize: '0.6rem', color: 'rgba(255, 255, 255, 0.4)', textTransform: 'uppercase', marginTop: '4px' }}>
                  Typowy zakres
                </div>
              </div>
            </div>

            {/* Sleep Stages */}
            <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <SleepStageBar 
                label="Sen głęboki" 
                durationText={formatHoursMins(sleepDeepHours)} 
                percentage={Math.min((sleepDeepHours / 2.5) * 100, 100)} 
                typicalStart={35} 
                typicalEnd={65} 
                colorClass="deep" 
              />
              <SleepStageBar 
                label="REM" 
                durationText={formatHoursMins(sleepRemHours)} 
                percentage={Math.min((sleepRemHours / 3.0) * 100, 100)} 
                typicalStart={40} 
                typicalEnd={75} 
                colorClass="rem" 
              />
              <SleepStageBar 
                label="Sen lekki" 
                durationText={formatHoursMins(sleepLightHours)} 
                percentage={Math.min((sleepLightHours / 5.5) * 100, 100)} 
                typicalStart={50} 
                typicalEnd={85} 
                colorClass="light" 
              />
              <SleepStageBar 
                label="Czas czuwania" 
                durationText={`${sleepAwakeMins} m`} 
                percentage={Math.min((sleepAwakeMins / 90) * 100, 100)} 
                typicalStart={10} 
                typicalEnd={45} 
                colorClass="awake" 
              />
            </div>
          </div>
        </div>

        {/* WAGA I SKŁAD CIAŁA */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">⚖️ Waga i Skład Ciała</span>
            <span style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.4)' }}>
              {summary.weight !== null && summary.weight !== undefined ? 'Zsynchronizowano' : 'Demo data'}
            </span>
          </div>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '1.8rem', fontWeight: '800', color: '#fff', letterSpacing: '-0.02em' }}>
                {weight} <span style={{ fontSize: '1rem', fontWeight: '500', color: 'rgba(255,255,255,0.4)' }}>kg</span>
              </span>
              <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', marginTop: '4px' }}>Bieżąca waga</span>
            </div>

            <div style={{ display: 'flex', gap: '20px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                <span style={{ fontSize: '1.2rem', fontWeight: '700', color: '#38bdf8' }}>
                  {fatRatio}%
                </span>
                <span style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}>Tłuszcz</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                <span style={{ fontSize: '1.2rem', fontWeight: '700', color: '#34d399' }}>
                  {muscleMass} <span style={{ fontSize: '0.8rem', fontWeight: '500' }}>kg</span>
                </span>
                <span style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}>Mięśnie</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '10px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>
              <span>Szacowany wskaźnik BMI</span>
              <span style={{ color: '#34d399', fontWeight: '600' }}>
                {weight ? (Math.round((weight / (1.80 * 1.80)) * 10) / 10) : 24.5} (W normie)
              </span>
            </div>
          </div>
          {renderWeightCompositionChart(historyData)}
        </div>

        {/* ODŻYWIANIE (NUTRITION) */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">Odżywianie</span>
            <span className="premium-title-info">▶</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '24px', margin: '8px 0' }}>
            <div style={{ position: 'relative', width: 92, height: 92, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {/* Calories circular gauge */}
              <RenderProgressCircle size={92} strokeWidth={8} percentage={Math.min((eatenCalories / (targetCalories || 2000)) * 100, 100)} color="#10b981" />
              <div style={{ position: 'absolute', textAlign: 'center' }}>
                <div style={{ fontSize: '1.25rem', fontWeight: '800', color: '#fff', lineHeight: 1 }}>
                  {eatenCalories}
                </div>
                <div style={{ fontSize: '0.65rem', color: 'rgba(255, 255, 255, 0.4)', textTransform: 'uppercase', marginTop: '2px' }}>
                  cals
                </div>
              </div>
            </div>
            
            {/* Macronutrients Progress Bars */}
            <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                  <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Węglowodany</span>
                  <span style={{ fontWeight: '700' }}>{Math.round(eatenCarbs)}g / {targetCarbs}g</span>
                </div>
                <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: '#06b6d4', width: `${Math.min((eatenCarbs / (targetCarbs || 250)) * 100, 100)}%` }}></div>
                </div>
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                  <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Białko</span>
                  <span style={{ fontWeight: '700' }}>{Math.round(eatenProtein)}g / {targetProtein}g</span>
                </div>
                <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: '#7c3aed', width: `${Math.min((eatenProtein / (targetProtein || 150)) * 100, 100)}%` }}></div>
                </div>
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                  <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Tłuszcz</span>
                  <span style={{ fontWeight: '700' }}>{Math.round(eatenFat)}g / {targetFat}g</span>
                </div>
                <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: '#fbbf24', width: `${Math.min((eatenFat / (targetFat || 80)) * 100, 100)}%` }}></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="dashboard-column">
        {/* ENERGIA I STRES */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">Energia i stres</span>
            <span className="premium-title-info">ⓘ</span>
          </div>
          
          {/* Battery segments */}
          <div className="energy-battery-row">
            <span style={{ fontSize: '1rem' }}>🔋</span>
            <div className="energy-battery-container">
              {Array.from({ length: 28 }).map((_, idx) => {
                const filledSegmentsCount = Math.round((batteryPct / 100) * 28);
                const isFilled = idx < filledSegmentsCount;
                return (
                  <div 
                    key={idx} 
                    className={`energy-battery-segment ${isFilled ? 'filled' : ''}`}
                  ></div>
                );
              })}
            </div>
            <span className="energy-battery-pct">{batteryPct}%</span>
            <span style={{ fontSize: '0.75rem', color: '#10b981', fontWeight: '700' }}>+{batteryPct - 33}%</span>
            <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)' }}>| 0%</span>
          </div>

          {/* Stress & HRV / RHR stats */}
          <div className="energy-stres-box">
            <div>
              <div className="energy-stres-score">20</div>
              <div style={{ fontSize: '0.65rem', color: 'rgba(255, 255, 255, 0.4)', marginTop: '4px' }}>
                Zaktualizowano: 05:18
              </div>
              <div className="energy-stres-substats">
                <span className="energy-stres-substat-green">29 Max</span>
                <span className="energy-stres-substat-blue">4 Min</span>
                <span className="energy-stres-substat-cyan">15 Avg</span>
              </div>
            </div>
            <div>
              {renderSparkline(stressPoints)}
            </div>
          </div>
        </div>

        {/* TRENDY ZDROWOTNE */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
          <div className="premium-title-row" style={{ padding: '0 4px' }}>
            <span className="premium-title" style={{ fontSize: '1.2rem' }}>Trendy zdrowotne ⓘ</span>
            <span 
              onClick={() => onNavigate && onNavigate('trends')} 
              style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}
            >
              Wykresy
            </span>
          </div>
          <div className="premium-grid-2" style={{ gap: '12px' }}>
            <TrendCard 
              title="Zmienność rytmu zatokowego" 
              valueText={String(hrv)} 
              unitText="ms" 
              activeSegment={hrv >= 48 ? "right" : "middle"} 
              color="blue" 
              footerText={hrv >= 48 ? "Wysoki > 48" : "Niski < 48"} 
              status="success" 
            />
            <TrendCard 
              title="Poziom tlenu we krwi" 
              valueText="98,4" 
              unitText="%" 
              activeSegment="right" 
              color="blue" 
              footerText="Wysoki > 97,8" 
              status="success" 
            />
            <TrendCard 
              title="Spoczynkowe tętno" 
              valueText={String(rhr)} 
              unitText="bpm" 
              activeSegment={rhr < 61 ? "left" : "middle"} 
              color="blue" 
              footerText={rhr < 61 ? "Niski < 61" : "Wysoki > 61"} 
              status="success" 
            />
            <TrendCard 
              title="Częstość oddechów" 
              valueText="13,8" 
              unitText="rpm" 
              activeSegment="middle" 
              color="green" 
              footerText="W zakresie 13,3-14" 
              status="success" 
            />
            <TrendCard 
              title="Słuch" 
              valueText="52" 
              unitText="dB" 
              activeSegment="left" 
              color="blue" 
              footerText="Niski < 55" 
              status="success" 
            />
            <TrendCard 
              title="Temperatura nadgarstka" 
              valueText="35,4" 
              unitText="°C" 
              activeSegment="left" 
              color="orange" 
              footerText="Niski < 35,6" 
              status="warning" 
            />
          </div>
        </div>

        {/* TRENING (TRAINING) */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">Trening ⓘ</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', margin: '4px 0' }}>
            <div style={{ fontSize: '0.85rem', color: 'rgba(255, 255, 255, 0.7)' }}>
              Obciążenie cardio
            </div>
            {/* Rainbow/gradient load slider */}
            <div className="cardio-load-gradient-bar">
              <div 
                className="cardio-load-handle" 
                style={{ left: `${currentLoadPos}%` }}
              ></div>
            </div>
          </div>

          <div style={{ marginTop: '12px' }}>
            <div style={{ fontSize: '0.85rem', color: 'rgba(255, 255, 255, 0.5)', fontWeight: '600', marginBottom: '8px' }}>
              Ostatnia aktywność
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {activities.map((act, idx) => (
                <div key={idx} className="premium-workout-card">
                  <div className="premium-workout-left">
                    <div className="premium-workout-icon-box">
                      {getWorkoutIcon(act.type)}
                    </div>
                    <div>
                      <div className="premium-workout-name">{act.type}</div>
                      <div className="premium-workout-duration">{act.duration}</div>
                    </div>
                  </div>
                  <div className="premium-workout-right">
                    <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', display: 'block' }}>{act.dateLabel}</span>
                    <span className="premium-workout-calories">{act.calories} kcal</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* STREFY TĘTNA (HR ZONES) */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">💓 Strefy Tętna (Karvonen)</span>
            <span style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.4)' }}>
              Na bazie RHR ({rhr} bpm)
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px', borderLeft: '3px solid #60a5fa' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#fff' }}>Strefa 1 (Regeneracja)</span>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#60a5fa' }}>{hrZone1Min}-{hrZone1Max} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>Aktywna regeneracja, bardzo lekki wysiłek</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px', borderLeft: '3px solid #34d399' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#fff' }}>Strefa 2 (Spalanie Tłuszczu)</span>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#34d399' }}>{hrZone2Min}-{hrZone2Max} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>Baza tlenowa, optymalne spalanie tłuszczu</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px', borderLeft: '3px solid #fbbf24' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#fff' }}>Strefa 3 (Cardio / Tempo)</span>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#fbbf24' }}>{hrZone3Min}-{hrZone3Max} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>Poprawa wydolności sercowo-naczyniowej</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px', borderLeft: '3px solid #f87171' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#fff' }}>Strefa 4 (Próg / Threshold)</span>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#f87171' }}>{hrZone4Min}-{hrZone4Max} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>Budowanie wytrzymałości beztlenowej</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px', borderLeft: '3px solid #ef4444' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#fff' }}>Strefa 5 (Maks. Wysiłek)</span>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: '#ef4444' }}>{hrZone5Min}-{userMaxHr} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>Trening beztlenowy, interwały, maksymalna wydolność</span>
            </div>
          </div>
        </div>
      </div>


      {/* CZAT Z DIETETYKIEM AI (Boczna szuflada / overlay) */}
      {isChatOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(10px)',
          display: 'flex',
          justifyContent: 'flex-end',
          zIndex: 9999,
          animation: 'fadeIn 0.2s ease-out'
        }} onClick={() => setIsChatOpen(false)}>
          <div style={{
            width: '100%',
            maxWidth: '450px',
            height: '100%',
            background: '#0d0e0e',
            borderLeft: '1px solid rgba(255,255,255,0.05)',
            display: 'flex',
            flexDirection: 'column',
            animation: 'slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
          }} onClick={(e) => e.stopPropagation()}>
            
            {/* Header czatu */}
            <div style={{
              padding: '20px',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.15rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>✨</span> Dietetyk AI
                </h3>
                <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)' }}>
                  Rozmowa z asystentem Dietetyk AI
                </span>
              </div>
              <button 
                onClick={() => setIsChatOpen(false)}
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: 'none',
                  color: '#fff',
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  cursor: 'pointer',
                  fontSize: '1rem'
                }}
              >
                ✕
              </button>
            </div>

            {/* Historia wiadomości */}
            <div style={{
              flexGrow: 1,
              padding: '20px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px'
            }}>
              {chatMessages.map((msg, idx) => (
                <div 
                  key={idx} 
                  style={{
                    alignSelf: msg.sender === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '85%',
                    padding: '12px 16px',
                    borderRadius: msg.sender === 'user' ? '18px 18px 2px 18px' : '18px 18px 18px 2px',
                    background: msg.sender === 'user' ? '#7c3aed' : 'rgba(255,255,255,0.03)',
                    border: msg.sender === 'user' ? 'none' : '1px solid rgba(255,255,255,0.05)',
                    color: '#fff',
                    fontSize: '0.9rem',
                    lineHeight: '1.45',
                    whiteSpace: 'pre-line'
                  }}
                >
                  {msg.text}
                </div>
              ))}
              {isSendingChat && (
                <div style={{
                  alignSelf: 'flex-start',
                  padding: '12px 16px',
                  borderRadius: '18px 18px 18px 2px',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.05)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '0.85rem',
                  color: 'rgba(255,255,255,0.4)'
                }}>
                  <div className="loading-pulse"></div>
                  <span>Dietetyk AI myśli...</span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input wiadomości */}
            <form 
              onSubmit={handleSendChat}
              style={{
                padding: '20px',
                borderTop: '1px solid rgba(255,255,255,0.05)',
                display: 'flex',
                gap: '10px'
              }}
            >
              <input
                type="text"
                placeholder="Zapytaj agenta np. o swój dzisiejszy sen..."
                className="input-field"
                style={{ flexGrow: 1, borderRadius: '12px', fontSize: '0.9rem' }}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                disabled={isSendingChat}
                required
              />
              <button 
                type="submit" 
                className="btn-primary" 
                style={{ width: '45px', height: '42px', padding: 0, borderRadius: '12px' }}
                disabled={isSendingChat}
              >
                ➔
              </button>
            </form>

          </div>
        </div>
      )}

      {/* Style animacji szuflady czatu */}
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>

    </div>
  );
}
