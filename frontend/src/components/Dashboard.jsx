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

export default function Dashboard({ summary, aiAdvice, sessionToken, selectedDate, onNavigate, onRefresh }) {
  const [historyData, setHistoryData] = useState([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isAddingWater, setIsAddingWater] = useState(false);
  const [customWaterAmount, setCustomWaterAmount] = useState('');
  const [waterMessage, setWaterMessage] = useState('');

  // Porównanie odżywiania tydzień/miesiąc i bilans kaloryczny narastająco
  const [nutritionComparison, setNutritionComparison] = useState(null);
  const [calorieBalance, setCalorieBalance] = useState(null);
  const [isLoadingComparison, setIsLoadingComparison] = useState(false);

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

  useEffect(() => {
    const fetchComparisonAndBalance = async () => {
      if (!sessionToken) return;
      setIsLoadingComparison(true);
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const [comparisonRes, balanceRes] = await Promise.all([
          fetch(`/api/dashboard/nutrition-comparison${dateParam}`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
          }),
          fetch(`/api/dashboard/calorie-balance${dateParam}`, {
            headers: { 'Authorization': `Bearer ${sessionToken}` }
          })
        ]);
        if (comparisonRes.ok) setNutritionComparison(await comparisonRes.json());
        if (balanceRes.ok) setCalorieBalance(await balanceRes.json());
      } catch (err) {
        console.error('Błąd pobierania porównania/bilansu kalorycznego:', err);
      } finally {
        setIsLoadingComparison(false);
      }
    };
    fetchComparisonAndBalance();
  }, [sessionToken, selectedDate]);

  const renderWeightCompositionChart = (data) => {
    let validData = data.filter(d => 
      (d.weight !== null && d.weight !== undefined) || 
      (d.fat_ratio !== null && d.fat_ratio !== undefined) ||
      (d.muscle_mass !== null && d.muscle_mass !== undefined)
    );

    if (validData.length === 0) {
      // Brak rzeczywistych danych wagi/składu ciała w bazie - pokazujemy
      // szczery komunikat o braku danych, bez generowania fałszywego wykresu.
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '10px', marginTop: '10px' }}>
          <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>
            📈 Trend składu ciała
          </div>
          <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.35)', padding: '12px 0', textAlign: 'center' }}>
            Brak danych - zsynchronizuj wagę z Withings, aby zobaczyć trend
          </div>
        </div>
      );
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
          <span>📈 Trend składu ciała (30 dni)</span>
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

  // Dane wyłącznie z bazy (backend) - bez sztucznych wartości demo.
  // Gdy w bazie nie ma jeszcze wartości za dany dzień, pokazujemy 0 / brak danych.
  const sleepScore = summary.sleep_score ?? 0;
  const readinessScore = summary.readiness_score ?? 0;

  const steps = summary.steps || 0;
  const activeCalories = summary.calories_burned_active || 0;
  const effortScore = activeCalories > 0 ? Math.round(Math.min((activeCalories / 800) * 100, 100)) : 0;
  const activeMinutes = summary.active_minutes || 0;

  const sleepDurationHours = summary.sleep_duration ?? 0;
  const sleepDeepHours = summary.sleep_deep ?? 0;
  const sleepRemHours = summary.sleep_rem ?? 0;
  const sleepAwakeMins = 0;
  const sleepLightHours = Math.max(sleepDurationHours - sleepDeepHours - sleepRemHours - (sleepAwakeMins / 60), 0);

  const rhr = summary.rhr || 0;
  const hrv = summary.hrv || 0;

  const weight = summary.weight ?? 0;
  const fatRatio = summary.fat_ratio ?? 0;
  const muscleMass = summary.muscle_mass ?? 0;

  // BMI - liczone wyłącznie z realnego wzrostu użytkownika (Ustawienia -> Wzrost).
  // Brak fałszywego domyślnego wzrostu 1.80m i brak fałszywego fallbacku "24.5".
  // Gdy nie ma wagi lub wzrostu, BMI po prostu nie jest pokazywane.
  const heightCm = summary.height_cm ?? null;
  const bmiValue = (weight > 0 && heightCm)
    ? Math.round((weight / ((heightCm / 100) * (heightCm / 100))) * 10) / 10
    : null;
  const bmiCategory = bmiValue === null
    ? null
    : bmiValue < 18.5 ? 'Niedowaga'
    : bmiValue < 25 ? 'W normie'
    : bmiValue < 30 ? 'Nadwaga'
    : 'Otyłość';

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

  // Licznik wody
  const waterMl = summary.water_ml || 0;
  const targetWaterMl = summary.target_water_ml || 2500;
  const waterPct = Math.min(Math.round((waterMl / targetWaterMl) * 100), 100);

  // Cel obciążenia (Athlytic/WHOOP style)
  // Wyznacza przedział docelowy w oparciu o readiness
  const loadGoalMin = Math.round(readinessScore * 0.4);
  const loadGoalMax = Math.round(readinessScore * 0.65);
  // Aktualne obciążenie na suwaku (np. wysiłek)
  const currentLoadPos = Math.max(Math.min(effortScore, 100), 5); // min 5% dla widoczności suwaka
  
  // Bateria energii - realny algorytm, bez sztucznych przesunięć.
  // Punkt startowy: readinessScore (realny wynik regeneracji z Oura/Apple Health).
  // Rozładowanie: proporcjonalne do dzisiejszych aktywnych kalorii względem celu
  // aktywności użytkownika (im więcej wysiłku względem celu, tym większy spadek -
  // analogicznie do "Body Battery" w urządzeniach typu Garmin, ale z realnych danych).
  // Brak readinessScore (brak synchronizacji urządzenia) = brak baterii, nie zgadujemy.
  const targetActiveCaloriesForBattery = summary.target_active_calories || 500;
  const batteryDepletion = readinessScore > 0
    ? Math.round(Math.min(activeCalories / targetActiveCaloriesForBattery, 1) * 20)
    : 0;
  const batteryPct = readinessScore > 0
    ? Math.max(Math.min(readinessScore - batteryDepletion, 100), 0)
    : null;

  // Porównanie z wczorajszym dniem - liczone z realnej historii (historyData),
  // tym samym algorytmem co dzisiejsza bateria. Brak danych za wczoraj = brak etykiety.
  const sortedHistoryForBattery = [...historyData].sort((a, b) => a.date.localeCompare(b.date));
  const todayHistoryIdx = selectedDate
    ? sortedHistoryForBattery.findIndex(d => d.date === selectedDate)
    : -1;
  const yesterdayHistoryRow = todayHistoryIdx > 0 ? sortedHistoryForBattery[todayHistoryIdx - 1] : null;
  let yesterdayBatteryPct = null;
  if (yesterdayHistoryRow && yesterdayHistoryRow.readiness_score > 0) {
    const yReadiness = yesterdayHistoryRow.readiness_score;
    const yActiveCalories = yesterdayHistoryRow.active_calories || 0;
    const yDepletion = Math.round(Math.min(yActiveCalories / targetActiveCaloriesForBattery, 1) * 20);
    yesterdayBatteryPct = Math.max(Math.min(yReadiness - yDepletion, 100), 0);
  }
  const batteryDelta = (batteryPct !== null && yesterdayBatteryPct !== null)
    ? batteryPct - yesterdayBatteryPct
    : null;

  // Ostatnia synchronizacja i źródło danych aktywności - pole `last_sync` było już
  // od dawna pobierane z backendu, ale nigdzie nie wyświetlane użytkownikowi.
  const lastSyncDate = summary.last_sync ? new Date(summary.last_sync) : null;
  const formatRelativeSync = (date) => {
    if (!date || isNaN(date.getTime())) return null;
    const diffMin = Math.round((Date.now() - date.getTime()) / 60000);
    if (diffMin < 1) return 'przed chwilą';
    if (diffMin < 60) return `${diffMin} min temu`;
    const diffHours = Math.round(diffMin / 60);
    if (diffHours < 24) return `${diffHours} godz. temu`;
    return `${Math.round(diffHours / 24)} dni temu`;
  };
  const lastSyncLabel = formatRelativeSync(lastSyncDate);
  const activitySourceLabels = { apple: '🍏 Apple Health', oura: '💍 Oura Ring', google_fit: '🟢 Google Fit' };
  const activitySourceLabel = summary.activity_source ? (activitySourceLabels[summary.activity_source] || summary.activity_source) : null;

  // Dystans i rozbicie aktywności dnia (Oura daily_activity / Google Fit / Apple Health) -
  // liczniki dzienne, zerujące się każdego dnia tak jak kroki (patrz backend dashboard.js).
  const distanceMeters = summary.distance_meters || 0;
  const distanceKm = Math.round((distanceMeters / 1000) * 10) / 10;
  const sedentaryMinutes = summary.sedentary_minutes || 0;
  const lowActivityMinutes = summary.low_activity_minutes || 0;
  const hasActivityBreakdown = distanceMeters > 0 || sedentaryMinutes > 0 || lowActivityMinutes > 0 || activeMinutes > 0;

  // Realny poziom stresu z Oury (endpoint daily_stress) - w przeciwieństwie do wcześniej
  // usuniętej, w 100% fałszywej sekcji, ta karta pojawia się TYLKO gdy backend faktycznie
  // ma realne dane (pierścionek z funkcją pomiaru stresu).
  const stressHighMinutes = summary.stress_high_minutes;
  const stressRecoveryMinutes = summary.stress_recovery_minutes;
  const stressSummary = summary.stress_summary;
  const hasStressData = stressHighMinutes != null || stressRecoveryMinutes != null || stressSummary != null;
  const stressSummaryLabels = { restored: 'Zregenerowany', normal: 'Normalny', stressful: 'Stresujący' };

  // Ostatni zapisany pomiar obwodów ciała - pełny CRUD i wykres trendu jest już w
  // ActivityTracker, tu tylko skrót najnowszej wartości na głównym Dashboardzie.
  const latestBodyMeasurement = summary.latest_body_measurement || null;

  // Streaki celów - liczone przez backend wyłącznie na bazie historii już zapisanej
  // w bazie (meals + health_metrics), zero nowych integracji (punkt 9 z analizy).
  const calorieStreakDays = summary.calorie_streak_days || 0;
  const sleepStreakDays = summary.sleep_streak_days || 0;

  // Lista ostatnich aktywności - tylko rzeczywiste treningi z bazy.
  // Gdy brak treningów, lista jest pusta (patrz pusty stan w renderze).
  const activities = (summary.workouts && summary.workouts.length > 0)
    ? summary.workouts.map(w => ({
        type: w.type,
        dateLabel: 'dzisiaj',
        duration: `${w.duration_mins} min`,
        calories: w.calories
      }))
    : [];

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

  // Dodanie wypitej wody (przyciski szybkiego dodawania + własna ilość)
  const handleAddWater = async (amountMl) => {
    const amount = Number(amountMl);
    if (!amount || isNaN(amount) || amount <= 0 || isAddingWater) return;
    setIsAddingWater(true);
    setWaterMessage('');
    try {
      const res = await fetch('/api/water/add', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ date: selectedDate, amount_ml: amount })
      });
      if (res.ok) {
        setCustomWaterAmount('');
        if (onRefresh) onRefresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setWaterMessage(data.error || 'Nie udało się zapisać wody.');
      }
    } catch (err) {
      setWaterMessage('Błąd sieciowy. Nie udało się zapisać wody.');
    } finally {
      setIsAddingWater(false);
    }
  };

  const handleResetWater = async () => {
    if (isAddingWater) return;
    setIsAddingWater(true);
    setWaterMessage('');
    try {
      const res = await fetch('/api/water/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ date: selectedDate })
      });
      if (res.ok) {
        if (onRefresh) onRefresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setWaterMessage(data.error || 'Nie udało się zresetować licznika wody.');
      }
    } catch (err) {
      setWaterMessage('Błąd sieciowy. Nie udało się zresetować licznika wody.');
    } finally {
      setIsAddingWater(false);
    }
  };

  // Formatowanie minut do godzin/minut
  const formatHoursMins = (hoursDecimal) => {
    const hours = Math.floor(hoursDecimal);
    const mins = Math.round((hoursDecimal - hours) * 60);
    return `${hours}h ${mins}m`;
  };

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

      {/* STATUS SYNCHRONIZACJI - dane już dawno zbierane (last_sync, activity_source),
          ale wcześniej nigdzie nie ujawnione użytkownikowi. */}
      <div data-testid="status-sync-bar" style={{ gridColumn: 'span 2', display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', padding: '0 4px', marginTop: '-6px', marginBottom: '4px', fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)' }}>
        <span>
          {lastSyncLabel ? `🔄 Zsynchronizowano: ${lastSyncLabel}` : '🔄 Brak jeszcze synchronizacji'}
        </span>
        {activitySourceLabel && (
          <span>· Źródło aktywności: {activitySourceLabel}</span>
        )}
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
          {(calorieStreakDays > 0 || sleepStreakDays > 0) && (
            <div style={{ display: 'flex', gap: '8px', padding: '0 4px', flexWrap: 'wrap' }}>
              {calorieStreakDays > 0 && (
                <span style={{ fontSize: '0.75rem', fontWeight: '700', color: '#fbbf24', background: 'rgba(251,191,36,0.1)', padding: '4px 10px', borderRadius: '999px' }}>
                  🔥 {calorieStreakDays} {calorieStreakDays === 1 ? 'dzień' : 'dni'} z rzędu w celu kalorycznym
                </span>
              )}
              {sleepStreakDays > 0 && (
                <span style={{ fontSize: '0.75rem', fontWeight: '700', color: '#38bdf8', background: 'rgba(56,189,248,0.1)', padding: '4px 10px', borderRadius: '999px' }}>
                  😴 {sleepStreakDays} {sleepStreakDays === 1 ? 'dzień' : 'dni'} z rzędu z celem snu
                </span>
              )}
            </div>
          )}
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
            <DailyGoalCard
              title="Woda"
              val1={waterMl.toLocaleString('pl-PL')}
              unit1="ml"
              percentage={waterPct}
              barType={waterPct < 30 ? "red" : "gradient"}
            />
          </div>
        </div>

        {/* PORÓWNANIE TYDZIEŃ/MIESIĄC I BILANS KALORYCZNY NARASTAJĄCO */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">📊 Porównanie i bilans</span>
          </div>
          {isLoadingComparison ? (
            <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)', padding: '10px 0' }}>
              Wczytywanie...
            </div>
          ) : (
            <>
              {nutritionComparison && (nutritionComparison.week.current.avg || nutritionComparison.month.current.avg) ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                  {[
                    { label: 'Tydzień', data: nutritionComparison.week },
                    { label: 'Miesiąc', data: nutritionComparison.month }
                  ].map(({ label, data }) => (
                    data.current.avg && (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                        <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                          {label} · śr. {data.current.avg.calories} kcal/dzień
                        </span>
                        <span style={{
                          fontWeight: '700',
                          color: data.calories_change_pct == null ? 'rgba(255,255,255,0.4)' : data.calories_change_pct > 0 ? '#f87171' : data.calories_change_pct < 0 ? '#34d399' : '#fff'
                        }}>
                          {data.calories_change_pct == null ? 'brak danych do porównania' : `${data.calories_change_pct > 0 ? '+' : ''}${data.calories_change_pct}% vs poprzedni okres`}
                        </span>
                      </div>
                    )
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0' }}>
                  Brak danych - dodaj więcej posiłków, aby zobaczyć porównanie
                </div>
              )}

              {calorieBalance && (calorieBalance.week.days_with_data > 0 || calorieBalance.month.days_with_data > 0) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '10px' }}>
                  {[
                    { label: '7 dni', data: calorieBalance.week },
                    { label: '30 dni', data: calorieBalance.month }
                  ].map(({ label, data }) => (
                    data.days_with_data > 0 && (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                        <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                          Bilans {label} vs cel ({data.days_with_data} {data.days_with_data === 1 ? 'dzień' : 'dni'} z danymi)
                        </span>
                        <span style={{ fontWeight: '700', color: data.balance_vs_target > 0 ? '#f87171' : data.balance_vs_target < 0 ? '#34d399' : '#fff' }}>
                          {data.balance_vs_target > 0 ? '+' : ''}{Math.round(data.balance_vs_target)} kcal
                        </span>
                      </div>
                    )
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* LICZNIK WODY - szybkie dodawanie */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">💧 Nawodnienie</span>
            <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)' }}>
              {waterMl.toLocaleString('pl-PL')} / {targetWaterMl.toLocaleString('pl-PL')} ml
            </span>
          </div>

          <div className="daily-goal-progress-container" style={{ margin: '8px 0 14px' }}>
            <div className="daily-goal-progress-track">
              <div
                className={`daily-goal-progress-fill ${waterPct < 30 ? 'red' : 'gradient'}`}
                style={{ width: `${waterPct}%` }}
              ></div>
            </div>
            <div className="daily-goal-pct">{waterPct}%</div>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-primary"
              disabled={isAddingWater}
              onClick={() => handleAddWater(250)}
              style={{ flex: '1 1 80px', padding: '10px 8px' }}
            >
              +250 ml
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={isAddingWater}
              onClick={() => handleAddWater(500)}
              style={{ flex: '1 1 80px', padding: '10px 8px' }}
            >
              +500 ml
            </button>
            <input
              type="number"
              min="1"
              placeholder="Własna (ml)"
              value={customWaterAmount}
              onChange={(e) => setCustomWaterAmount(e.target.value)}
              style={{
                flex: '1 1 100px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '10px',
                color: '#fff',
                padding: '0 10px',
                fontSize: '0.85rem'
              }}
            />
            <button
              type="button"
              className="btn-primary"
              disabled={isAddingWater || !customWaterAmount}
              onClick={() => handleAddWater(Number(customWaterAmount))}
              style={{ flex: '1 1 80px', padding: '10px 8px' }}
            >
              Dodaj
            </button>
            <button
              type="button"
              disabled={isAddingWater}
              onClick={handleResetWater}
              style={{
                flex: '1 1 80px',
                padding: '10px 8px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '10px',
                color: 'rgba(255,255,255,0.6)',
                cursor: 'pointer',
                fontSize: '0.85rem'
              }}
            >
              Reset
            </button>
          </div>

          {waterMessage && (
            <div style={{ marginTop: '8px', fontSize: '0.75rem', color: '#ef4444' }}>
              {waterMessage}
            </div>
          )}
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
              {summary.weight !== null && summary.weight !== undefined ? 'Zsynchronizowano' : 'Brak danych'}
            </span>
          </div>
          
          {(() => {
            const fatMass = (weight > 0 && fatRatio > 0) ? Math.round((weight * fatRatio / 100) * 10) / 10 : 0;
            const fatPercentage = fatRatio || 0;
            const musclePercentage = (weight > 0 && muscleMass > 0) ? Math.round((muscleMass / weight) * 100 * 10) / 10 : 0;
            const otherMass = (weight > 0) ? Math.max(0, Math.round((weight - muscleMass - fatMass) * 10) / 10) : 0;
            const otherPercentage = (weight > 0) ? Math.max(0, Math.round((otherMass / weight) * 100 * 10) / 10) : 0;
            const leanBodyMassPct = fatRatio > 0 ? 100 - fatRatio : 100;

            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: '24px', margin: '8px 0' }}>
                {/* Main weight ring */}
                <div style={{ position: 'relative', width: 92, height: 92, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <RenderProgressCircle size={92} strokeWidth={8} percentage={leanBodyMassPct} color="#38bdf8" />
                  <div style={{ position: 'absolute', textAlign: 'center' }}>
                    <div style={{ fontSize: '1.25rem', fontWeight: '800', color: '#fff', lineHeight: 1 }}>
                      {weight > 0 ? weight : '--'}
                    </div>
                    <div style={{ fontSize: '0.65rem', color: 'rgba(255, 255, 255, 0.4)', textTransform: 'uppercase', marginTop: '2px' }}>
                      kg
                    </div>
                  </div>
                </div>

                {/* Body Composition breakdown */}
                <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                      <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Mięśnie</span>
                      <span style={{ fontWeight: '700' }}>{muscleMass > 0 ? `${muscleMass} kg` : '--'} ({musclePercentage}%)</span>
                    </div>
                    <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', background: '#34d399', width: `${musclePercentage}%` }}></div>
                    </div>
                  </div>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                      <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Tłuszcz</span>
                      <span style={{ fontWeight: '700' }}>{fatMass > 0 ? `${fatMass} kg` : '--'} ({fatPercentage}%)</span>
                    </div>
                    <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', background: '#fbbf24', width: `${fatPercentage}%` }}></div>
                    </div>
                  </div>
                  {otherMass > 0 && (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '2px' }}>
                        <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Inne (woda, kości)</span>
                        <span style={{ fontWeight: '700' }}>{otherMass} kg ({otherPercentage}%)</span>
                      </div>
                      <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ height: '100%', background: '#64748b', width: `${otherPercentage}%` }}></div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '10px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>
              <span>Wskaźnik BMI</span>
              {bmiValue !== null ? (
                <span style={{ color: '#34d399', fontWeight: '600' }}>
                  {bmiValue} ({bmiCategory})
                </span>
              ) : (
                <span style={{ color: 'rgba(255,255,255,0.3)', fontWeight: '500' }}>
                  Brak danych (ustaw wzrost w Ustawieniach)
                </span>
              )}
            </div>
            {latestBodyMeasurement && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginTop: '4px' }}>
                <span>Ostatni pomiar obwodów ({latestBodyMeasurement.date})</span>
                <span style={{ color: 'rgba(255,255,255,0.7)', fontWeight: '600', textAlign: 'right' }}>
                  {[
                    latestBodyMeasurement.waist != null && `Pas: ${latestBodyMeasurement.waist}cm`,
                    latestBodyMeasurement.chest != null && `Klatka: ${latestBodyMeasurement.chest}cm`,
                    latestBodyMeasurement.hips != null && `Biodra: ${latestBodyMeasurement.hips}cm`,
                    latestBodyMeasurement.biceps != null && `Biceps: ${latestBodyMeasurement.biceps}cm`,
                    latestBodyMeasurement.thigh != null && `Udo: ${latestBodyMeasurement.thigh}cm`
                  ].filter(Boolean).join(' · ') || 'Brak wypełnionych pól'}
                </span>
              </div>
            )}
          </div>
          {renderWeightCompositionChart(historyData)}
        </div>

      </div>

      <div className="dashboard-column">
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

        {/* ENERGIA I STRES */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">Energia i stres</span>
            <span className="premium-title-info">ⓘ</span>
          </div>
          
          {/* Battery segments - realny algorytm (readinessScore - rozładowanie aktywnością) */}
          <div className="energy-battery-row">
            <span style={{ fontSize: '1rem' }}>🔋</span>
            <div className="energy-battery-container">
              {Array.from({ length: 28 }).map((_, idx) => {
                const filledSegmentsCount = batteryPct !== null ? Math.round((batteryPct / 100) * 28) : 0;
                const isFilled = idx < filledSegmentsCount;
                return (
                  <div
                    key={idx}
                    className={`energy-battery-segment ${isFilled ? 'filled' : ''}`}
                  ></div>
                );
              })}
            </div>
            {batteryPct !== null ? (
              <>
                <span className="energy-battery-pct">{batteryPct}%</span>
                {batteryDelta !== null ? (
                  <span style={{ fontSize: '0.75rem', color: batteryDelta >= 0 ? '#10b981' : '#f87171', fontWeight: '700' }}>
                    {batteryDelta >= 0 ? '+' : ''}{batteryDelta}% vs wczoraj
                  </span>
                ) : (
                  <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)' }}>Brak danych z wczoraj</span>
                )}
              </>
            ) : (
              <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)' }}>Brak danych (czekam na synchronizację)</span>
            )}
          </div>
          {/* Realny poziom stresu (Oura /v2/usercollection/daily_stress) - wcześniej ta
              sekcja była tu usunięta, bo była w 100% zaszywana na sztywno bez żadnego
              realnego źródła danych. Wraca tylko wtedy, gdy backend faktycznie ma dla
              niej dane (pierścionek Oura z funkcją pomiaru stresu) - inaczej jest po
              prostu niewidoczna, bez fałszywych wartości. */}
          {hasStressData && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.6)' }}>😮‍💨 Poziom stresu (Oura)</span>
                {stressSummary && (
                  <span style={{ fontSize: '0.75rem', fontWeight: '700', color: stressSummary === 'stressful' ? '#f87171' : stressSummary === 'restored' ? '#34d399' : '#fbbf24' }}>
                    {stressSummaryLabels[stressSummary] || stressSummary}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '16px' }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: '1rem', fontWeight: '700', color: '#f87171' }}>
                    {stressHighMinutes != null ? `${stressHighMinutes} min` : '-'}
                  </span>
                  <span style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)' }}>Stres dzisiaj</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: '1rem', fontWeight: '700', color: '#34d399' }}>
                    {stressRecoveryMinutes != null ? `${stressRecoveryMinutes} min` : '-'}
                  </span>
                  <span style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)' }}>Regeneracja dzisiaj</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* DYSTANS I AKTYWNOŚĆ DNIA - dane z Oury (equivalent_walking_distance,
            sedentary/low_activity_time), Google Fit (distance.delta) albo Apple Health
            (walking_running_distance) - wcześniej pobierane przez integracje, ale
            nieujawnione w /api/dashboard. */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">🏃 Dystans i aktywność dnia</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '1.6rem', fontWeight: '800', color: '#fff' }}>
                {distanceKm > 0 ? distanceKm : '-'} <span style={{ fontSize: '0.9rem', fontWeight: '500', color: 'rgba(255,255,255,0.4)' }}>km</span>
              </span>
              <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)' }}>Dystans dzisiaj</span>
            </div>
          </div>
          {hasActivityBreakdown ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>🔥 Aktywne minuty</span>
                <span style={{ fontWeight: '700' }}>{activeMinutes} min</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>🚶 Niska intensywność</span>
                <span style={{ fontWeight: '700' }}>{lowActivityMinutes} min</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>🪑 Bezruch</span>
                <span style={{ fontWeight: '700' }}>{sedentaryMinutes} min</span>
              </div>
              {(activeMinutes > 0 || lowActivityMinutes > 0 || sedentaryMinutes > 0) && (
                <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', marginTop: '4px', background: 'rgba(255,255,255,0.05)' }}>
                  {activeMinutes > 0 && <div style={{ background: '#ef4444', flex: activeMinutes }}></div>}
                  {lowActivityMinutes > 0 && <div style={{ background: '#fbbf24', flex: lowActivityMinutes }}></div>}
                  {sedentaryMinutes > 0 && <div style={{ background: 'rgba(255,255,255,0.15)', flex: sedentaryMinutes }}></div>}
                </div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0' }}>
              Brak danych - czekam na synchronizację
            </div>
          )}
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
              title="Spoczynkowe tętno"
              valueText={String(rhr)}
              unitText="bpm"
              activeSegment={rhr < 61 ? "left" : "middle"}
              color="blue"
              footerText={rhr < 61 ? "Niski < 61" : "Wysoki > 61"}
              status="success"
            />
            {/* Karta "Słuch" pozostaje usunięta na życzenie użytkownika - Oura nie ma
                mikrofonu, a Apple Watch/AirPods nie są jeszcze obsługiwane. Poniższe
                3 karty pokazują się tylko, gdy backend faktycznie ma dla nich realną
                wartość (Gen 3+ Oura dla SpO2, Apple Watch Series 8+/Ultra z włączoną
                metryką "Wrist Temperature" w Health Auto Export dla temperatury) -
                w przeciwnym razie karta jest po prostu niewidoczna, bez fałszywych zer. */}
            {summary.respiratory_rate != null && (
              <TrendCard
                title="Częstość oddechów"
                valueText={String(summary.respiratory_rate)}
                unitText="odd/min"
                activeSegment={summary.respiratory_rate < 12 ? "left" : summary.respiratory_rate > 20 ? "right" : "middle"}
                color="blue"
                footerText={summary.respiratory_rate >= 12 && summary.respiratory_rate <= 20 ? "Norma 12-20" : "Poza normą 12-20"}
                status={summary.respiratory_rate >= 12 && summary.respiratory_rate <= 20 ? "success" : "warning"}
              />
            )}
            {summary.spo2_percentage != null && (
              <TrendCard
                title="Poziom tlenu we krwi"
                valueText={String(summary.spo2_percentage)}
                unitText="%"
                activeSegment={summary.spo2_percentage >= 98 ? "right" : summary.spo2_percentage >= 95 ? "middle" : "left"}
                color="blue"
                footerText={summary.spo2_percentage >= 95 ? "Prawidłowy ≥ 95%" : "Niski < 95%"}
                status={summary.spo2_percentage >= 95 ? "success" : "warning"}
              />
            )}
            {summary.wrist_temperature != null && (
              <TrendCard
                title="Temperatura nadgarstka"
                valueText={String(summary.wrist_temperature)}
                unitText="°C"
                activeSegment="middle"
                color="blue"
                footerText="Pomiar nocny (Apple Watch)"
                status="success"
              />
            )}
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
              {activities.length > 0 ? activities.map((act, idx) => (
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
              )) : (
                <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.35)', textAlign: 'center', padding: '8px 0' }}>
                  Brak zarejestrowanych aktywności
                </div>
              )}
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
