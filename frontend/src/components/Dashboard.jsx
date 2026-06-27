import React, { useState, useEffect, useRef } from 'react';
import { getTemperatureStatus } from '../utils/health';
import { formatHoursMins } from '../utils/format';

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
  // type może nie przyjść z backendu (trening bez przypisanej kategorii) -
  // bez fallbacku do '' aplikacja wywaliłaby się na .toLowerCase() na undefined.
  const t = (type || '').toLowerCase();
  if (t.includes('run') || t.includes('bieg')) return '🏃';
  if (t.includes('walk') || t.includes('spacer') || t.includes('marsz')) return '🚶';
  if (t.includes('cycle') || t.includes('rower')) return '🚴';
  if (t.includes('swim') || t.includes('pływ')) return '🏊';
  if (t.includes('strength') || t.includes('siłownia') || t.includes('ciężar')) return '🏋️';
  if (t.includes('cardio') || t.includes('aerob')) return '⚡';
  if (t.includes('yoga') || t.includes('joga')) return '🧘';
  if (t.includes('box') || t.includes('boks') || t.includes('walka')) return '🥊';
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

const PRESET_SUPPLEMENTS = [
  { name: 'Kreatyna', icon: '⚡', match: ['kreatyn'] },
  { name: 'Ashwagandha', icon: '🌿', match: ['ashwagandh'] },
  { name: 'GABA', icon: '🧠', match: ['gaba'] },
  { name: 'Rhodiola', icon: '🌱', match: ['rhodiol', 'różeniec'] },
  { name: 'Multiwitamina 7Nutrition', icon: '🧬', match: ['multiwitam', 'multivitamin', 'witamin', '7nutrition'] }
];

const getSupplementIconsForText = (text) => {
  if (!text) return [];
  const lowerText = text.toLowerCase();
  const icons = [];
  let matchedAny = false;
  PRESET_SUPPLEMENTS.forEach(sup => {
    const isMatch = sup.match.some(m => lowerText.includes(m.toLowerCase()));
    if (isMatch) {
      icons.push(sup.icon);
      matchedAny = true;
    }
  });
  if (!matchedAny && text.trim().length > 0) {
    icons.push('💊');
  }
  return icons;
};

const getLast7Days = (endDateStr) => {
  const days = [];
  const endDate = new Date(endDateStr);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(endDate);
    d.setDate(d.getDate() - i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    
    const weekday = d.toLocaleDateString('pl-PL', { weekday: 'short' });
    days.push({ date: dateStr, label: weekday, dayNum: d.getDate() });
  }
  return days;
};

export default function Dashboard({ summary, aiAdvice, sessionToken, selectedDate, onNavigate, onRefresh }) {
  const [historyData, setHistoryData] = useState([]);
  const [historyTrigger, setHistoryTrigger] = useState(0);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isAddingWater, setIsAddingWater] = useState(false);
  const [customWaterAmount, setCustomWaterAmount] = useState('');
  const [waterMessage, setWaterMessage] = useState('');
  
  // Stany dla suplementacji
  const [supplementsText, setSupplementsText] = useState('');
  const [isSavingSupplements, setIsSavingSupplements] = useState(false);
  const [supplementsMessage, setSupplementsMessage] = useState({ type: '', text: '' });

  const handleToggleSupplement = (sup) => {
    let items = supplementsText
      ? supplementsText.split(',').map(item => item.trim()).filter(Boolean)
      : [];

    const matchIndex = items.findIndex(item => 
      sup.match.some(keyword => item.toLowerCase().includes(keyword))
    );

    if (matchIndex >= 0) {
      items.splice(matchIndex, 1);
    } else {
      items.push(sup.name);
    }

    setSupplementsText(items.join(', '));
  };

  const isSupplementActive = (sup) => {
    if (!supplementsText) return false;
    const lowerText = supplementsText.toLowerCase();
    return sup.match.some(keyword => lowerText.includes(keyword));
  };

  // Inicjalizacja tekstu suplementów przy zmianie summary (np. zmiana daty)
  useEffect(() => {
    if (summary) {
      setSupplementsText(summary.supplements || '');
    }
  }, [summary]);

  const handleSaveSupplements = async () => {
    if (!sessionToken) return;
    setIsSavingSupplements(true);
    setSupplementsMessage({ type: '', text: '' });
    try {
      const res = await fetch('/api/supplements', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({
          date: selectedDate,
          supplements: supplementsText
        })
      });
      if (res.ok) {
        setSupplementsMessage({ type: 'success', text: 'Zapisano suplementy!' });
        setHistoryTrigger(prev => prev + 1);
        if (onRefresh) {
          onRefresh(); // Odśwież dane dashboardu (i wyzwalaj generowanie nowej porady AI w tle)
        }
        setTimeout(() => setSupplementsMessage({ type: '', text: '' }), 5000);
      } else {
        setSupplementsMessage({ type: 'error', text: 'Błąd zapisu.' });
      }
    } catch (err) {
      console.error(err);
      setSupplementsMessage({ type: 'error', text: 'Błąd połączenia z serwerem.' });
    } finally {
      setIsSavingSupplements(false);
    }
  };

  // Porównanie odżywiania tydzień/miesiąc i bilans kaloryczny narastająco
  const [nutritionComparison, setNutritionComparison] = useState(null);
  const [calorieBalance, setCalorieBalance] = useState(null);
  const [isLoadingComparison, setIsLoadingComparison] = useState(false);

  // Insight: sen -> kalorie/cukier następnego dnia (porównanie opisowe średnich
  // z ostatnich 90 dni, patrz endpoint /api/dashboard/sleep-insight).
  const [sleepInsight, setSleepInsight] = useState(null);
  const [isLoadingSleepInsight, setIsLoadingSleepInsight] = useState(false);

  useEffect(() => {
    const fetchSleepInsight = async () => {
      if (!sessionToken) return;
      setIsLoadingSleepInsight(true);
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/sleep-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setSleepInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu sen-odżywianie:', err);
      } finally {
        setIsLoadingSleepInsight(false);
      }
    };
    fetchSleepInsight();
  }, [sessionToken, selectedDate]);

  // Alert/insight: sód -> ciśnienie (patrz endpoint /api/dashboard/sodium-bp-insight).
  const [sodiumBpInsight, setSodiumBpInsight] = useState(null);

  useEffect(() => {
    const fetchSodiumBpInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/sodium-bp-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setSodiumBpInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu sód-ciśnienie:', err);
      }
    };
    fetchSodiumBpInsight();
  }, [sessionToken, selectedDate]);

  // Wskaźnik regeneracji: HRV/RHR następnego dnia po znaczącym treningu
  // (patrz endpoint /api/dashboard/recovery-insight).
  const [recoveryInsight, setRecoveryInsight] = useState(null);

  useEffect(() => {
    const fetchRecoveryInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/recovery-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setRecoveryInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania wskaźnika regeneracji:', err);
      }
    };
    fetchRecoveryInsight();
  }, [sessionToken, selectedDate]);

  // Insight: suplementy (wolny tekst) vs sen/regeneracja TEGO SAMEGO dnia
  // (patrz endpoint /api/dashboard/supplements-sleep-insight) - własna analiza
  // danych już zbieranych przez aplikację (suplementy + Oura), bez kopiowania
  // niczego z konkurencyjnych apek.
  const [supplementsSleepInsight, setSupplementsSleepInsight] = useState(null);

  useEffect(() => {
    const fetchSupplementsSleepInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/supplements-sleep-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setSupplementsSleepInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu suplementy-sen:', err);
      }
    };
    fetchSupplementsSleepInsight();
  }, [sessionToken, selectedDate]);

  // Runda 7: 8 nowych insightów na bazie danych już zbieranych przez aplikację -
  // ten sam wzorzec fetch/state co powyżej (sleepInsight, sodiumBpInsight, itd.).
  const [hydrationInsight, setHydrationInsight] = useState(null);
  useEffect(() => {
    const fetchHydrationInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/hydration-readiness-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setHydrationInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu nawodnienie-regeneracja:', err);
      }
    };
    fetchHydrationInsight();
  }, [sessionToken, selectedDate]);

  const [sedentaryInsight, setSedentaryInsight] = useState(null);
  useEffect(() => {
    const fetchSedentaryInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/sedentary-sleep-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setSedentaryInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu siedzenie-sen:', err);
      }
    };
    fetchSedentaryInsight();
  }, [sessionToken, selectedDate]);

  const [fiberSleepInsight, setFiberSleepInsight] = useState(null);
  useEffect(() => {
    const fetchFiberSleepInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/fiber-sleep-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setFiberSleepInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu błonnik-sen:', err);
      }
    };
    fetchFiberSleepInsight();
  }, [sessionToken, selectedDate]);

  const [bodyRecompInsight, setBodyRecompInsight] = useState(null);
  useEffect(() => {
    const fetchBodyRecompInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/body-recomposition-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setBodyRecompInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu rekompozycji ciała:', err);
      }
    };
    fetchBodyRecompInsight();
  }, [sessionToken, selectedDate]);

  const [strainAlert, setStrainAlert] = useState(null);
  useEffect(() => {
    const fetchStrainAlert = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/early-strain-alert${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setStrainAlert(await res.json());
      } catch (err) {
        console.error('Błąd pobierania alertu przeciążenia:', err);
      }
    };
    fetchStrainAlert();
  }, [sessionToken, selectedDate]);

  const [stressNutritionInsight, setStressNutritionInsight] = useState(null);
  useEffect(() => {
    const fetchStressNutritionInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/stress-nutrition-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setStressNutritionInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu stres-odżywianie:', err);
      }
    };
    fetchStressNutritionInsight();
  }, [sessionToken, selectedDate]);

  const [mealFreqInsight, setMealFreqInsight] = useState(null);
  useEffect(() => {
    const fetchMealFreqInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/meal-frequency-adherence-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setMealFreqInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu częstość posiłków:', err);
      }
    };
    fetchMealFreqInsight();
  }, [sessionToken, selectedDate]);

  const [streakDriftInsight, setStreakDriftInsight] = useState(null);
  useEffect(() => {
    const fetchStreakDriftInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/streak-drift-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setStreakDriftInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu passa-regeneracja:', err);
      }
    };
    fetchStreakDriftInsight();
  }, [sessionToken, selectedDate]);

  const [rhrDriftInsight, setRhrDriftInsight] = useState(null);
  useEffect(() => {
    const fetchRhrDriftInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/rhr-drift-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setRhrDriftInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu trendu tętna spoczynkowego:', err);
      }
    };
    fetchRhrDriftInsight();
  }, [sessionToken, selectedDate]);

  const [mealTimingSleepInsight, setMealTimingSleepInsight] = useState(null);
  useEffect(() => {
    const fetchMealTimingSleepInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/meal-timing-sleep-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setMealTimingSleepInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu godzina posiłku-sen:', err);
      }
    };
    fetchMealTimingSleepInsight();
  }, [sessionToken, selectedDate]);

  const [bpTrendInsight, setBpTrendInsight] = useState(null);
  useEffect(() => {
    const fetchBpTrendInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/bp-trend-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setBpTrendInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu trendu ciśnienia krwi:', err);
      }
    };
    fetchBpTrendInsight();
  }, [sessionToken, selectedDate]);

  // Realne strefy kardio (Karvonen) zsumowane z treningów Apple Health z ostatnich 14 dni
  // - w przeciwieństwie do statycznej tabeli referencyjnej "Strefy Tętna" (wzór, nie pomiar),
  // to są minuty faktycznie zmierzone tętnem podczas treningu (wymaga włączonego "Include
  // Workout Metrics" w Health Auto Export). Patrz /api/dashboard/hr-zones-insight.
  const [hrZonesInsight, setHrZonesInsight] = useState(null);
  useEffect(() => {
    const fetchHrZonesInsight = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/hr-zones-insight${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setHrZonesInsight(await res.json());
      } catch (err) {
        console.error('Błąd pobierania insightu stref kardio:', err);
      }
    };
    fetchHrZonesInsight();
  }, [sessionToken, selectedDate]);

  // Zwijalna sekcja "Analizy" (UX: rundy 7 - 12 kart insightów w jednym miejscu,
  // domyślnie zwinięta, żeby nie zalewać dashboardu od razu po wejściu).
  const [isAnalizyOpen, setIsAnalizyOpen] = useState(false);
  // Zwijalna tabela stref tętna (UX: rundy 7 - statyczna tabela referencyjna 5
  // strefy, nie trzeba jej widzieć od razu, wystarczy link rozwijający).
  const [isHrZonesOpen, setIsHrZonesOpen] = useState(false);
  // Zwijalna historia suplementacji (UX: runda 7 - pasek 7 dni + lista "Ostatnio
  // przyjmowane" domyślnie schowane za "Pokaż historię", widoczny tylko licznik).
  const [isSupplementsHistoryOpen, setIsSupplementsHistoryOpen] = useState(false);

  // Adaptacyjna korekta celu kalorycznego: porównanie deklarowanego bilansu
  // (z zalogowanych posiłków) z bilansem wynikającym z realnej zmiany wagi
  // (patrz endpoint /api/dashboard/calorie-target-suggestion). caloriesTrigger
  // wymusza ponowne pobranie po kliknięciu "Zastosuj", żeby karta zniknęła/
  // zaktualizowała się bez czekania na pełne odświeżenie strony.
  const [calorieSuggestion, setCalorieSuggestion] = useState(null);
  const [caloriesTrigger, setCaloriesTrigger] = useState(0);
  const [isApplyingCalorieSuggestion, setIsApplyingCalorieSuggestion] = useState(false);

  useEffect(() => {
    const fetchCalorieSuggestion = async () => {
      if (!sessionToken) return;
      try {
        const dateParam = selectedDate ? `?date=${selectedDate}` : '';
        const res = await fetch(`/api/dashboard/calorie-target-suggestion${dateParam}`, {
          headers: { 'Authorization': `Bearer ${sessionToken}` }
        });
        if (res.ok) setCalorieSuggestion(await res.json());
      } catch (err) {
        console.error('Błąd pobierania korekty celu kalorycznego:', err);
      }
    };
    fetchCalorieSuggestion();
  }, [sessionToken, selectedDate, caloriesTrigger]);

  const handleApplyCalorieSuggestion = async () => {
    if (!calorieSuggestion || !calorieSuggestion.suggestedTargetCalories || isApplyingCalorieSuggestion) return;
    setIsApplyingCalorieSuggestion(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ target_calories: calorieSuggestion.suggestedTargetCalories })
      });
      if (res.ok) {
        if (onRefresh) onRefresh();
        setCaloriesTrigger(t => t + 1);
      }
    } catch (err) {
      console.error('Błąd zapisu nowego celu kalorycznego:', err);
    } finally {
      setIsApplyingCalorieSuggestion(false);
    }
  };

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
  }, [sessionToken, summary.last_sync, historyTrigger]);

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
              <span style={{ width: '6px', height: '6px', background: 'var(--success-light)', borderRadius: '50%' }}></span> Mięśnie
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
            {dMuscle && <path d={dMuscle} fill="none" stroke="var(--success-light)" strokeWidth="1.5" strokeLinecap="round" />}
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

  // POPRAWKA (runda 4 audytu): cele dzienne (kroki, kalorie, sen, minuty ćwiczeń) mogą
  // być świadomie zapisane jako 0 (cel wyłączony - patrz `??` w kartach celów niżej oraz
  // poprawka w dashboard.js/ActivityTracker.jsx, gdzie `||` wcześniej bezpowrotnie
  // nadpisywało takie 0 domyślną wartością). Samo dzielenie przez cel=0 dawałoby
  // Infinity/NaN w procencie paska postępu - helper jawnie traktuje wyłączony cel jako
  // "0% do pokazania" zamiast renderować NaN%.
  const goalProgressPct = (value, target) => target > 0 ? Math.min(Math.round((value / target) * 100), 100) : 0;

  const steps = summary.steps || 0;
  // activeCalories: 0 i "brak danych" są tu równoważne (brak treningu = 0 kalorii
  // aktywnych), więc || 0 zostaje - w odróżnieniu od rhr/hrv poniżej.
  const activeCalories = summary.calories_burned_active || 0;
  // POPRAWKA (runda 4 audytu): effortScore liczył % wysiłku względem sztywnych 800
  // kcal, a "Bateria energii" niżej liczy rozładowanie względem
  // targetActiveCaloriesForBattery (cel z ustawień, domyślnie 500 kcal) - dwie karty
  // opisujące tę samą aktywność dnia dawały niespójne, nieporównywalne ze sobą %,
  // gdy cel użytkownika różnił się od 800 kcal. Ujednolicone na wspólny mianownik.
  // POPRAWKA (runda 4 audytu): `||` nadpisywał świadomie zapisany cel=0 (wyłączony cel
  // aktywnych kalorii, patrz dashboard.js/ActivityTracker.jsx) domyślnym 500. `??`
  // zachowuje realne 0 - dzielenie przez nie jest bezpieczne tutaj, bo effortScore i
  // batteryDepletion niżej mają osobne zabezpieczenie przed 0/0 (NaN).
  const targetActiveCaloriesForBattery = summary.target_active_calories ?? 500;
  const effortScore = activeCalories > 0 ? Math.round(Math.min((activeCalories / targetActiveCaloriesForBattery) * 100, 100)) : 0;
  const activeMinutes = summary.active_minutes || 0;

  const sleepDurationHours = summary.sleep_duration ?? 0;
  const sleepDeepHours = summary.sleep_deep ?? 0;
  const sleepRemHours = summary.sleep_rem ?? 0;
  // sleepAwakeMins nie jest jeszcze wyliczane z danych Oura (zawsze 0) - karta
  // "Czas czuwania" jest dlatego ukrywana w renderze, żeby nie pokazywać fałszywego 0m.
  const sleepAwakeMins = 0;
  const sleepLightHours = Math.max(sleepDurationHours - sleepDeepHours - sleepRemHours - (sleepAwakeMins / 60), 0);

  // rhr/hrv: 0 byłoby fizjologicznie nierealną wartością, więc tu (w odróżnieniu od
  // np. steps) używamy ?? null, żeby odróżnić "brak danych" od realnego pomiaru.
  const rhr = summary.rhr ?? null;
  const hrv = summary.hrv ?? null;

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

  // Kalkulacja stref tętna (Karvonen) na bazie RHR z Oura.
  // userMaxHr: realne HRmax (220 - wiek) liczone przez backend z roku urodzenia
  // użytkownika (Ustawienia -> Rok urodzenia). Fallback 190 (~wiek 30 lat) tylko
  // gdy użytkownik nie podał roku urodzenia.
  const userMaxHr = summary.user_max_hr || 190;
  // rhr może być null (brak danych z Oura za ten dzień) - do samych obliczeń
  // używamy lokalnego fallbacku 0, ale karta poniżej jest ukrywana, gdy rhr == null,
  // żeby nie pokazywać stref wyliczonych z fałszywego RHR.
  const rhrForZones = rhr ?? 0;
  const hrReserve = userMaxHr - rhrForZones;
  const hrZone1Min = Math.round(hrReserve * 0.5 + rhrForZones);
  const hrZone1Max = Math.round(hrReserve * 0.6 + rhrForZones);
  const hrZone2Min = Math.round(hrReserve * 0.6 + rhrForZones);
  const hrZone2Max = Math.round(hrReserve * 0.7 + rhrForZones);
  const hrZone3Min = Math.round(hrReserve * 0.7 + rhrForZones);
  const hrZone3Max = Math.round(hrReserve * 0.8 + rhrForZones);
  const hrZone4Min = Math.round(hrReserve * 0.8 + rhrForZones);
  const hrZone4Max = Math.round(hrReserve * 0.9 + rhrForZones);
  const hrZone5Min = Math.round(hrReserve * 0.9 + rhrForZones);
  
  // Odżywianie
  // Użyto ?? (nie ||), bo cel ustawiony świadomie na 0 (np. dieta eliminacyjna jednego
  // makroskładnika) nie powinien być nadpisywany domyślną wartością - ten sam wzorzec
  // błędu naprawiony już wcześniej dla target_steps/target_active_calories/itd.
  const targetCalories = summary.target_calories ?? 2000;
  const eatenCalories = summary.calories_eaten || 0;
  const targetProtein = summary.target_protein ?? 150;
  const targetCarbs = summary.target_carbs ?? 250;
  const targetFat = summary.target_fat ?? 80;
  const eatenProtein = summary.eaten_protein || 0;
  const eatenCarbs = summary.eaten_carbs || 0;
  const eatenFat = summary.eaten_fat || 0;

  // Licznik wody
  const waterMl = summary.water_ml || 0;
  // POPRAWKA (runda 4 audytu): jak wyżej - `??` zachowuje świadomie zapisane 0 (cel
  // wyłączony), a waterPct dostaje jawne zabezpieczenie przed dzieleniem 0/0 (NaN),
  // gdy cel=0 i nic jeszcze nie wypito.
  const targetWaterMl = summary.target_water_ml ?? 2500;
  const waterPct = targetWaterMl > 0 ? Math.min(Math.round((waterMl / targetWaterMl) * 100), 100) : 0;

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
  // POPRAWKA (runda 4 audytu): gdy cel aktywnych kalorii jest świadomie ustawiony na 0
  // (patrz `??` powyżej), a użytkownik nie spalił żadnych aktywnych kalorii, samo
  // dzielenie 0/0 dawało NaN i psuło całą "baterię energii" - dodane jawne
  // zabezpieczenie: cel=0 oznacza brak rozładowania (rozładowanie tylko gdy jest realny
  // cel do przekroczenia).
  const batteryDepletion = readinessScore > 0 && targetActiveCaloriesForBattery > 0
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
  // UWAGA: poprzednio dateLabel był zahardkodowany na 'dzisiaj' niezależnie od
  // selectedDate - przy przeglądaniu dashboardu za inny dzień (date picker w App.jsx)
  // karta treningu błędnie pokazywała "dzisiaj" dla treningów z tamtego dnia.
  const todayLocalStr = (() => {
    const d = new Date();
    const tzOffset = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - tzOffset).toISOString().slice(0, 10);
  })();
  const activities = (summary.workouts && summary.workouts.length > 0)
    ? summary.workouts.map(w => ({
        type: w.type,
        dateLabel: (!selectedDate || selectedDate === todayLocalStr) ? 'dzisiaj' : selectedDate,
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

  // `overrideText` pozwala wysłać wiadomość bez przepisywania jej do pola input -
  // używane przez chipy szybkich pytań (Runda 8), które wysyłają gotowy tekst od razu
  // po kliknięciu, zamiast najpierw wstawiać go do <input> i czekać na osobny submit.
  const handleSendChat = async (e, overrideText) => {
    if (e && e.preventDefault) e.preventDefault();
    const userMsg = (overrideText !== undefined ? overrideText : chatInput).trim();
    if (!userMsg || isSendingChat) return;

    setChatInput('');
    // Budujemy nową historię jawnie (a nie przez closure na `chatMessages`) - setChatMessages
    // poniżej jest asynchroniczny, więc zmienna `chatMessages` w tym wywołaniu funkcji
    // wciąż wskazywałaby na stan SPRZED dodania aktualnej wiadomości użytkownika (stale
    // closure). Bez tej poprawki backend (routes/chat.js) dostawał historię, w której
    // brakowało właśnie wysłanej wiadomości - AI odpowiadał bez kontekstu ostatniego pytania.
    const updatedHistory = [...chatMessages, { sender: 'user', text: userMsg }];
    setChatMessages(updatedHistory);
    setIsSendingChat(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ message: userMsg, date: selectedDate, history: updatedHistory })
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

  // formatHoursMins przeniesione do utils/format.js (import na górze pliku) -
  // ta sama logika była duplikowana też w Trends.jsx i potencjalnie ActivityTracker.jsx.

  // Renderowanie porady AI jako Markdown (pogrubienia, listy punktowane).
  // dashboard.js prosi Gemini o odpowiedź w Markdown - bez tej konwersji
  // React wyświetliłby "**tekst**" dosłownie, z gwiazdkami na ekranie.
  // Najpierw escapujemy HTML (tekst generuje LLM, mógł przepisać coś od
  // użytkownika), potem zamieniamy tylko znane znaczniki Markdown na HTML.
  const escapeHtml = (str) => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Rozpoznaje nagłówki (## Analiza / ### Coś), listy punktowane ("- "/"* ") ORAZ
  // numerowane ("1. ") - poprzednia wersja obsługiwała tylko listy punktowane i
  // akapity, więc nowa, ustrukturyzowana odpowiedź AI (nagłówki "## Analiza" /
  // "## Rekomendacje" z promptu w dashboard.js) renderowała się jako zwykły tekst
  // z widocznymi "##" na ekranie. Domykamy każdą listę/nagłówek przy zmianie typu
  // linii, żeby nigdy nie zostawić otwartego <ul>/<ol>.
  const renderAdviceMarkdown = (text) => {
    if (!text) return '';
    const lines = escapeHtml(text).split('\n');
    let html = '';
    let listType = null; // 'ul' | 'ol' | null
    const closeList = () => {
      if (listType) { html += `</${listType}>`; listType = null; }
    };
    lines.forEach((rawLine) => {
      const line = rawLine.trim();
      const headingMatch = line.match(/^(#{2,4})\s+(.*)/);
      const bulletMatch = line.match(/^[*-]\s+(.*)/);
      const orderedMatch = line.match(/^\d+[.)]\s+(.*)/);
      if (headingMatch) {
        closeList();
        const level = headingMatch[1].length >= 4 ? 'h6' : headingMatch[1].length === 3 ? 'h5' : 'h4';
        html += `<${level} class="dietetyk-ai-advice-heading">${headingMatch[2]}</${level}>`;
      } else if (bulletMatch) {
        if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
        html += `<li>${bulletMatch[1]}</li>`;
      } else if (orderedMatch) {
        if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
        html += `<li>${orderedMatch[1]}</li>`;
      } else {
        closeList();
        html += line === '' ? '<br/>' : `<p>${line}</p>`;
      }
    });
    closeList();
    return html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
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
        {aiAdvice && aiAdvice.length > 30 ? (
          <div
            className="dietetyk-ai-advice-text"
            dangerouslySetInnerHTML={{ __html: renderAdviceMarkdown(aiAdvice) }}
          />
        ) : (
          <p className="dietetyk-ai-advice-text">
            {`Twoja regeneracja trzyma stabilny poziom (${readinessScore}%). HRV wynosi ${hrv} ms i mieści się w normie, więc organizm nie protestuje przeciwko aktywności. Dobrym wyborem będzie lekki tlenowy wysiłek kardio lub sesja mobility.`}
          </p>
        )}
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
                <RenderProgressCircle size={84} strokeWidth={7} percentage={effortScore} color={effortScore > 0 ? "var(--danger)" : "rgba(255,255,255,0.08)"} />
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
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate && onNavigate('activity'); } }}
              role="button"
              tabIndex={0}
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
              percentage={goalProgressPct(steps, summary?.target_steps ?? 10000)}
              barType={goalProgressPct(steps, summary?.target_steps ?? 10000) < 30 ? "red" : "gradient"}
            />
            <DailyGoalCard
              title="Aktywne kalorie"
              val1={String(activeCalories)}
              unit1="kcal"
              percentage={goalProgressPct(activeCalories, summary?.target_active_calories ?? 500)}
              barType="gradient"
            />
            <DailyGoalCard
              title="Czas snu"
              val1={String(Math.floor(sleepDurationHours))}
              unit1="godz"
              val2={String(Math.round((sleepDurationHours - Math.floor(sleepDurationHours)) * 60))}
              unit2="min"
              percentage={goalProgressPct(sleepDurationHours, summary?.target_sleep_duration ?? 7.2)}
              barType="gradient"
            />
            <DailyGoalCard
              title="Minuty ćwiczeń"
              val1={String(activeMinutes)}
              unit1="min"
              percentage={goalProgressPct(activeMinutes, summary?.target_active_minutes ?? 30)}
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
                          color: data.calories_change_pct == null ? 'rgba(255,255,255,0.4)' : data.calories_change_pct > 0 ? 'var(--danger-light)' : data.calories_change_pct < 0 ? 'var(--success-light)' : '#fff'
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
                        <span style={{ fontWeight: '700', color: data.balance_vs_target > 0 ? 'var(--danger-light)' : data.balance_vs_target < 0 ? 'var(--success-light)' : '#fff' }}>
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

        {/* ZWIJALNA SEKCJA "ANALIZY" - 12 kart opisowych porównań (sen, sód,
            regeneracja, suplementy + 8 nowych z rundy 7), domyślnie zwinięta,
            żeby nie zalewać dashboardu od razu po wejściu (UX runda 7, punkt 1). */}
        <div
          className="premium-card"
          role="button"
          tabIndex={0}
          aria-expanded={isAnalizyOpen}
          onClick={() => setIsAnalizyOpen(o => !o)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsAnalizyOpen(o => !o); } }}
          style={{ cursor: 'pointer' }}
        >
          <div className="premium-title-row" style={{ marginBottom: 0 }}>
            <span className="premium-title">📊 Analizy</span>
            <span style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)' }}>
              {isAnalizyOpen ? 'Zwiń ▲' : 'Pokaż ▼'}
            </span>
          </div>
        </div>

        {isAnalizyOpen && (
          <>
        {/* INSIGHT: SEN -> ODŻYWIANIE NASTĘPNEGO DNIA */}
        {!isLoadingSleepInsight && sleepInsight && sleepInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">😴 Sen → następny dzień</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Po nocach krócej niż {sleepInsight.sleepThreshold}h (cel snu) vs po nocach z wystarczającym snem - ostatnie 90 dni
              ({sleepInsight.shortSleepNights} vs {sleepInsight.goodSleepNights} dni z danymi).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  Kalorie: {sleepInsight.avgCaloriesAfterShortSleep} kcal vs {sleepInsight.avgCaloriesAfterGoodSleep} kcal
                </span>
                <span style={{ fontWeight: '700', color: sleepInsight.caloriesDiff > 0 ? 'var(--danger-light)' : sleepInsight.caloriesDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                  {sleepInsight.caloriesDiff > 0 ? '+' : ''}{sleepInsight.caloriesDiff} kcal
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  Cukier: {sleepInsight.avgSugarAfterShortSleep}g vs {sleepInsight.avgSugarAfterGoodSleep}g
                </span>
                <span style={{ fontWeight: '700', color: sleepInsight.sugarDiff > 0 ? 'var(--danger-light)' : sleepInsight.sugarDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                  {sleepInsight.sugarDiff > 0 ? '+' : ''}{sleepInsight.sugarDiff} g
                </span>
              </div>
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              To porównanie dwóch średnich z Twoich danych, nie dowód naukowy - im więcej dni z danymi, tym bardziej wiarygodne.
            </p>
          </div>
        )}
        {!isLoadingSleepInsight && sleepInsight && !sleepInsight.hasEnoughData && sleepInsight.reason === 'not_enough_nights' && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">😴 Sen → następny dzień</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', textAlign: 'center', padding: '8px 0', marginBottom: 0 }}>
              Za mało dni z danymi o śnie i posiłkach (min. {sleepInsight.minNightsRequired} w każdej grupie - krótki/wystarczający sen).
              Obecnie: {sleepInsight.shortSleepNights} vs {sleepInsight.goodSleepNights}.
            </p>
          </div>
        )}

        {/* ALERT/INSIGHT: SÓD -> CIŚNIENIE - karta pojawia się tylko, gdy jest coś
            realnie do powiedzenia: dzisiejszy sód jest wysoki LUB mamy wystarczającą
            historię do personalnego porównania. Inaczej karta byłaby pustym szumem
            na większości dni. */}
        {sodiumBpInsight && (sodiumBpInsight.today?.isHigh || sodiumBpInsight.insight?.hasEnoughData) && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🧂 Sód → ciśnienie</span>
            </div>
            {sodiumBpInsight.today?.isHigh && (
              <p style={{ fontSize: '0.78rem', color: 'var(--danger-light)', marginTop: '2px', marginBottom: sodiumBpInsight.insight?.hasEnoughData ? '10px' : 0, fontWeight: 600 }}>
                ⚠️ Dziś spożycie sodu: {sodiumBpInsight.today.sodium} mg - powyżej zalecanego dziennego limitu ({sodiumBpInsight.sodiumThresholdMg} mg, wytyczne WHO/AHA).
              </p>
            )}
            {sodiumBpInsight.insight?.hasEnoughData && (
              <>
                <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginBottom: '10px' }}>
                  Dni z wysokim sodem vs dni z sodem w normie - ciśnienie następnego dnia, ostatnie 90 dni
                  ({sodiumBpInsight.insight.highSodiumDays} vs {sodiumBpInsight.insight.normalSodiumDays} dni z danymi).
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                      Skurczowe: {sodiumBpInsight.insight.avgSystolicAfterHighSodium} vs {sodiumBpInsight.insight.avgSystolicAfterNormalSodium} mmHg
                    </span>
                    <span style={{ fontWeight: '700', color: sodiumBpInsight.insight.systolicDiff > 0 ? 'var(--danger-light)' : sodiumBpInsight.insight.systolicDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                      {sodiumBpInsight.insight.systolicDiff > 0 ? '+' : ''}{sodiumBpInsight.insight.systolicDiff} mmHg
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                      Rozkurczowe: {sodiumBpInsight.insight.avgDiastolicAfterHighSodium} vs {sodiumBpInsight.insight.avgDiastolicAfterNormalSodium} mmHg
                    </span>
                    <span style={{ fontWeight: '700', color: sodiumBpInsight.insight.diastolicDiff > 0 ? 'var(--danger-light)' : sodiumBpInsight.insight.diastolicDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                      {sodiumBpInsight.insight.diastolicDiff > 0 ? '+' : ''}{sodiumBpInsight.insight.diastolicDiff} mmHg
                    </span>
                  </div>
                </div>
                <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
                  Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
                </p>
              </>
            )}
          </div>
        )}

        {/* WSKAŹNIK REGENERACJI: HRV/RHR PO TRENINGU */}
        {recoveryInsight && recoveryInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🔄 Regeneracja po treningu</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              {/* Próg "znaczącego" treningu (20 min) jest ustalony w backendzie
                  (SIGNIFICANT_WORKOUT_MIN_MINUTES w dashboard.js) - tu tylko opisowo. */}
              Dzień po znaczącym treningu (min. 20 min) vs zwykłe dni - ostatnie 90 dni
              ({recoveryInsight.postWorkoutDays} vs {recoveryInsight.otherDays} dni z danymi).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  HRV: {recoveryInsight.avgHrvPostWorkout} vs {recoveryInsight.avgHrvOtherDays} ms
                </span>
                <span style={{ fontWeight: '700', color: recoveryInsight.hrvDiff < 0 ? 'var(--danger-light)' : recoveryInsight.hrvDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                  {recoveryInsight.hrvDiff > 0 ? '+' : ''}{recoveryInsight.hrvDiff} ms
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  RHR: {recoveryInsight.avgRhrPostWorkout} vs {recoveryInsight.avgRhrOtherDays} bpm
                </span>
                <span style={{ fontWeight: '700', color: recoveryInsight.rhrDiff > 0 ? 'var(--danger-light)' : recoveryInsight.rhrDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                  {recoveryInsight.rhrDiff > 0 ? '+' : ''}{recoveryInsight.rhrDiff} bpm
                </span>
              </div>
            </div>
            {recoveryInsight.latest && (
              <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,0.05)', marginBottom: 0 }}>
                Ostatni trening ({recoveryInsight.latest.workoutDate}): regeneracja {recoveryInsight.latest.recoveryDate} -
                HRV {recoveryInsight.latest.hrv} ms, RHR {recoveryInsight.latest.rhr} bpm.
              </p>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '8px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie diagnoza medyczna.
            </p>
          </div>
        )}

        {/* SUPLEMENTY VS SEN/REGENERACJA */}
        {supplementsSleepInsight && supplementsSleepInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">💊 Suplementy vs sen i regeneracja</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Dni z danym suplementem vs bez niego, ten sam dzień - ostatnie {supplementsSleepInsight.lookbackDays} dni.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {supplementsSleepInsight.findings.map((f) => (
                <div key={f.supplement} style={{ paddingBottom: '8px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: '700', color: '#fff', marginBottom: '4px', overflowWrap: 'break-word' }}>
                    {f.supplement} <span style={{ fontWeight: '400', color: 'rgba(255,255,255,0.4)' }}>({f.daysWith} vs {f.daysWithout} dni)</span>
                  </div>
                  {f.sleepScoreDiff != null && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                        Sen: {f.avgSleepScoreWith} vs {f.avgSleepScoreWithout}
                      </span>
                      <span style={{ fontWeight: '700', color: f.sleepScoreDiff < 0 ? 'var(--danger-light)' : f.sleepScoreDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                        {f.sleepScoreDiff > 0 ? '+' : ''}{f.sleepScoreDiff}
                      </span>
                    </div>
                  )}
                  {f.readinessScoreDiff != null && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                        Gotowość: {f.avgReadinessScoreWith} vs {f.avgReadinessScoreWithout}
                      </span>
                      <span style={{ fontWeight: '700', color: f.readinessScoreDiff < 0 ? 'var(--danger-light)' : f.readinessScoreDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                        {f.readinessScoreDiff > 0 ? '+' : ''}{f.readinessScoreDiff}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '8px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód skuteczności suplementu.
            </p>
          </div>
        )}

        {/* INSIGHT: NAWODNIENIE -> GOTOWOŚĆ/HRV/RHR */}
        {hydrationInsight && hydrationInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">💧 Nawodnienie → regeneracja</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Dni z nawodnieniem ≥ Twojego celu ({hydrationInsight.targetWaterMl} ml) vs dni poniżej celu - ostatnie 90 dni
              ({hydrationInsight.hydratedDays} vs {hydrationInsight.underHydratedDays} dni z danymi).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {hydrationInsight.readinessDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Gotowość: {hydrationInsight.avgReadinessHydrated} vs {hydrationInsight.avgReadinessUnderHydrated}
                  </span>
                  <span style={{ fontWeight: '700', color: hydrationInsight.readinessDiff < 0 ? 'var(--danger-light)' : hydrationInsight.readinessDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {hydrationInsight.readinessDiff > 0 ? '+' : ''}{hydrationInsight.readinessDiff}
                  </span>
                </div>
              )}
              {hydrationInsight.hrvDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    HRV: {hydrationInsight.avgHrvHydrated} vs {hydrationInsight.avgHrvUnderHydrated} ms
                  </span>
                  <span style={{ fontWeight: '700', color: hydrationInsight.hrvDiff < 0 ? 'var(--danger-light)' : hydrationInsight.hrvDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {hydrationInsight.hrvDiff > 0 ? '+' : ''}{hydrationInsight.hrvDiff} ms
                  </span>
                </div>
              )}
              {hydrationInsight.nextDayRhrDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    RHR (następny dzień): {hydrationInsight.avgNextDayRhrHydrated} vs {hydrationInsight.avgNextDayRhrUnderHydrated} bpm
                  </span>
                  <span style={{ fontWeight: '700', color: hydrationInsight.nextDayRhrDiff > 0 ? 'var(--danger-light)' : hydrationInsight.nextDayRhrDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                    {hydrationInsight.nextDayRhrDiff > 0 ? '+' : ''}{hydrationInsight.nextDayRhrDiff} bpm
                  </span>
                </div>
              )}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* INSIGHT: SIEDZENIE -> SEN TEJ SAMEJ NOCY */}
        {sedentaryInsight && sedentaryInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🪑 Siedzenie → sen</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Dni z czasem siedzącym ≥ Twojej mediany ({sedentaryInsight.medianSedentaryMinutes} min) vs poniżej mediany - ostatnie 90 dni
              ({sedentaryInsight.moreSittingDays} vs {sedentaryInsight.lessSittingDays} dni z danymi).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {sedentaryInsight.sleepScoreDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Wynik snu: {sedentaryInsight.avgSleepScoreMoreSitting} vs {sedentaryInsight.avgSleepScoreLessSitting}
                  </span>
                  <span style={{ fontWeight: '700', color: sedentaryInsight.sleepScoreDiff < 0 ? 'var(--danger-light)' : sedentaryInsight.sleepScoreDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {sedentaryInsight.sleepScoreDiff > 0 ? '+' : ''}{sedentaryInsight.sleepScoreDiff}
                  </span>
                </div>
              )}
              {sedentaryInsight.sleepDeepDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Sen głęboki: {sedentaryInsight.avgSleepDeepMoreSitting} vs {sedentaryInsight.avgSleepDeepLessSitting} min
                  </span>
                  <span style={{ fontWeight: '700', color: sedentaryInsight.sleepDeepDiff < 0 ? 'var(--danger-light)' : sedentaryInsight.sleepDeepDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {sedentaryInsight.sleepDeepDiff > 0 ? '+' : ''}{sedentaryInsight.sleepDeepDiff} min
                  </span>
                </div>
              )}
              {sedentaryInsight.sleepRemDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Sen REM: {sedentaryInsight.avgSleepRemMoreSitting} vs {sedentaryInsight.avgSleepRemLessSitting} min
                  </span>
                  <span style={{ fontWeight: '700', color: sedentaryInsight.sleepRemDiff < 0 ? 'var(--danger-light)' : sedentaryInsight.sleepRemDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {sedentaryInsight.sleepRemDiff > 0 ? '+' : ''}{sedentaryInsight.sleepRemDiff} min
                  </span>
                </div>
              )}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* INSIGHT: BŁONNIK -> SEN GŁĘBOKI/REM TEJ SAMEJ NOCY */}
        {fiberSleepInsight && fiberSleepInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🌾 Błonnik → sen</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Dni ze spożyciem błonnika ≥ Twojej mediany ({fiberSleepInsight.medianFiberGrams} g) vs poniżej mediany, ten sam dzień - ostatnie 90 dni
              ({fiberSleepInsight.moreFiberDays} vs {fiberSleepInsight.lessFiberDays} dni z danymi).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {fiberSleepInsight.sleepDeepDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Sen głęboki: {fiberSleepInsight.avgSleepDeepMoreFiber} vs {fiberSleepInsight.avgSleepDeepLessFiber} min
                  </span>
                  <span style={{ fontWeight: '700', color: fiberSleepInsight.sleepDeepDiff < 0 ? 'var(--danger-light)' : fiberSleepInsight.sleepDeepDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {fiberSleepInsight.sleepDeepDiff > 0 ? '+' : ''}{fiberSleepInsight.sleepDeepDiff} min
                  </span>
                </div>
              )}
              {fiberSleepInsight.sleepRemDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Sen REM: {fiberSleepInsight.avgSleepRemMoreFiber} vs {fiberSleepInsight.avgSleepRemLessFiber} min
                  </span>
                  <span style={{ fontWeight: '700', color: fiberSleepInsight.sleepRemDiff < 0 ? 'var(--danger-light)' : fiberSleepInsight.sleepRemDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {fiberSleepInsight.sleepRemDiff > 0 ? '+' : ''}{fiberSleepInsight.sleepRemDiff} min
                  </span>
                </div>
              )}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* DETEKTOR REKOMPOZYCJI CIAŁA - tylko, gdy trendy pasa i wagi się rozjeżdżają */}
        {bodyRecompInsight && bodyRecompInsight.hasEnoughData && bodyRecompInsight.divergentTrend && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">📐 Rekompozycja ciała</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Trend obwodu pasa i trend wagi idą w różnych kierunkach - możliwy sygnał zmiany składu ciała (np. przyrost mięśni przy redukcji tkanki tłuszczowej), nie tylko samej wagi.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Pas (trend/tydzień)</span>
                <span style={{ fontWeight: '700', color: bodyRecompInsight.waistSlopeCmPerWeek < 0 ? 'var(--success-light)' : bodyRecompInsight.waistSlopeCmPerWeek > 0 ? 'var(--danger-light)' : '#fff' }}>
                  {bodyRecompInsight.waistSlopeCmPerWeek > 0 ? '+' : ''}{bodyRecompInsight.waistSlopeCmPerWeek} cm
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Waga (trend/tydzień)</span>
                <span style={{ fontWeight: '700', color: '#fff' }}>
                  {bodyRecompInsight.weightSlopeKgPerWeek > 0 ? '+' : ''}{bodyRecompInsight.weightSlopeKgPerWeek} kg
                </span>
              </div>
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Regresja liniowa z Twoich pomiarów, nie pomiar składu ciała (np. DEXA) - traktuj jako wskazówkę, nie fakt.
            </p>
          </div>
        )}

        {/* WCZESNY ALERT PRZECIĄŻENIA/MOŻLIWEJ INFEKCJI - tylko gdy alert aktywny */}
        {strainAlert && strainAlert.hasEnoughData && strainAlert.alert && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">⚠️ Sygnały przeciążenia</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'var(--danger-light)', marginTop: '2px', marginBottom: '10px', fontWeight: 600 }}>
              Dziś częstość oddechów, odchylenie temperatury i gotowość naraz odbiegają od Twojej średniej z ostatnich {strainAlert.baselineDays} dni - możliwy sygnał przetrenowania lub początku infekcji.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Częstość oddechów</span>
                <span style={{ fontWeight: '700', color: '#fff' }}>{strainAlert.today.respiratoryRate} vs śr. {strainAlert.baseline.avgRespiratoryRate}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Odchylenie temperatury</span>
                <span style={{ fontWeight: '700', color: '#fff' }}>{strainAlert.today.temperatureDeviation}°C vs śr. {strainAlert.baseline.avgTemperatureDeviation}°C</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Gotowość</span>
                <span style={{ fontWeight: '700', color: '#fff' }}>{strainAlert.today.readinessScore} vs śr. {strainAlert.baseline.avgReadinessScore}</span>
              </div>
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Sygnał statystyczny na bazie Twojej własnej historii, NIE diagnoza medyczna - przy złym samopoczuciu skonsultuj się z lekarzem.
            </p>
          </div>
        )}

        {/* INSIGHT: STRES -> SÓD/CUKIER TEGO SAMEGO DNIA */}
        {stressNutritionInsight && stressNutritionInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">😰 Stres → odżywianie</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Dni z minutami wysokiego stresu ≥ Twojej mediany ({stressNutritionInsight.medianStressMinutes} min) vs poniżej mediany, ten sam dzień - ostatnie 90 dni
              ({stressNutritionInsight.highStressDays} vs {stressNutritionInsight.lowStressDays} dni z danymi).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {stressNutritionInsight.sodiumDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Sód: {stressNutritionInsight.avgSodiumHighStress} vs {stressNutritionInsight.avgSodiumLowStress} mg
                  </span>
                  <span style={{ fontWeight: '700', color: stressNutritionInsight.sodiumDiff > 0 ? 'var(--danger-light)' : stressNutritionInsight.sodiumDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                    {stressNutritionInsight.sodiumDiff > 0 ? '+' : ''}{stressNutritionInsight.sodiumDiff} mg
                  </span>
                </div>
              )}
              {stressNutritionInsight.sugarDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Cukier: {stressNutritionInsight.avgSugarHighStress} vs {stressNutritionInsight.avgSugarLowStress} g
                  </span>
                  <span style={{ fontWeight: '700', color: stressNutritionInsight.sugarDiff > 0 ? 'var(--danger-light)' : stressNutritionInsight.sugarDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                    {stressNutritionInsight.sugarDiff > 0 ? '+' : ''}{stressNutritionInsight.sugarDiff} g
                  </span>
                </div>
              )}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* INSIGHT: LICZBA POSIŁKÓW DZIENNIE -> TRAFIENIE W CEL KALORYCZNY */}
        {mealFreqInsight && mealFreqInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🍽️ Częstość posiłków → cel</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Dni, w których trafiłeś w cel kaloryczny (±15%) vs dni, w których nie - ostatnie 90 dni
              ({mealFreqInsight.onTargetDays} vs {mealFreqInsight.offTargetDays} dni z danymi).
            </p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                Śr. liczba posiłków: {mealFreqInsight.avgMealCountOnTarget} vs {mealFreqInsight.avgMealCountOffTarget}
              </span>
              <span style={{ fontWeight: '700', color: '#fff' }}>
                {mealFreqInsight.mealCountDiff > 0 ? '+' : ''}{mealFreqInsight.mealCountDiff}
              </span>
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* INSIGHT: PASA TRZYMANIA CELU -> REGENERACJA PO PRZERWANIU */}
        {streakDriftInsight && streakDriftInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🔥 Passa celu → regeneracja</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Dni w trakcie passy trzymania celu kalorycznego (min. {streakDriftInsight.streakMinLength} dni z rzędu) vs dzień bezpośrednio po jej przerwaniu
              ({streakDriftInsight.streakDays} vs {streakDriftInsight.breakDays} dni z danymi).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {streakDriftInsight.hrvDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    HRV: {streakDriftInsight.avgHrvDuringStreak} vs {streakDriftInsight.avgHrvAfterBreak} ms
                  </span>
                  <span style={{ fontWeight: '700', color: streakDriftInsight.hrvDiff < 0 ? 'var(--danger-light)' : streakDriftInsight.hrvDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {streakDriftInsight.hrvDiff > 0 ? '+' : ''}{streakDriftInsight.hrvDiff} ms
                  </span>
                </div>
              )}
              {streakDriftInsight.readinessDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Gotowość: {streakDriftInsight.avgReadinessDuringStreak} vs {streakDriftInsight.avgReadinessAfterBreak}
                  </span>
                  <span style={{ fontWeight: '700', color: streakDriftInsight.readinessDiff < 0 ? 'var(--danger-light)' : streakDriftInsight.readinessDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {streakDriftInsight.readinessDiff > 0 ? '+' : ''}{streakDriftInsight.readinessDiff}
                  </span>
                </div>
              )}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* INSIGHT (Runda 8): TREND SPOCZYNKOWEGO TĘTNA */}
        {rhrDriftInsight && rhrDriftInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">❤️ Trend tętna spoczynkowego</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Średnie RHR z ostatnich {rhrDriftInsight.recentDays} dni vs Twoja własna baseline z poprzedzających {rhrDriftInsight.baselineDays} dni.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  RHR: {rhrDriftInsight.avgRecentRhr} vs {rhrDriftInsight.avgBaselineRhr} bpm
                </span>
                <span style={{ fontWeight: '700', color: rhrDriftInsight.rhrDiff > 0 ? 'var(--danger-light)' : rhrDriftInsight.rhrDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                  {rhrDriftInsight.rhrDiff > 0 ? '+' : ''}{rhrDriftInsight.rhrDiff} bpm
                </span>
              </div>
            </div>
            {rhrDriftInsight.isElevated && (
              <p style={{ fontSize: '0.74rem', color: 'var(--danger-light)', marginTop: '10px', marginBottom: 0 }}>
                ⚠️ Tętno spoczynkowe ostatnio podniesione względem Twojej baseline - może to być sygnał przemęczenia, stresu albo zaczynającej się infekcji.
              </p>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* INSIGHT (Runda 8): GODZINA OSTATNIEGO POSIŁKU -> SEN */}
        {mealTimingSleepInsight && mealTimingSleepInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🍽️ Godzina posiłku → sen</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Twoja mediana godziny ostatniego posiłku to {mealTimingSleepInsight.medianLastMealHour}. Porównanie snu w dniach z późniejszym ({mealTimingSleepInsight.laterEatingDays} dni) vs wcześniejszym ({mealTimingSleepInsight.earlierEatingDays} dni) ostatnim posiłkiem.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {mealTimingSleepInsight.sleepScoreDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Wynik snu: {mealTimingSleepInsight.avgSleepScoreLaterEating} vs {mealTimingSleepInsight.avgSleepScoreEarlierEating}
                  </span>
                  <span style={{ fontWeight: '700', color: mealTimingSleepInsight.sleepScoreDiff < 0 ? 'var(--danger-light)' : mealTimingSleepInsight.sleepScoreDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {mealTimingSleepInsight.sleepScoreDiff > 0 ? '+' : ''}{mealTimingSleepInsight.sleepScoreDiff}
                  </span>
                </div>
              )}
              {mealTimingSleepInsight.sleepDeepDiff != null && (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '4px', fontSize: '0.78rem' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 0 }}>
                    Sen głęboki: {mealTimingSleepInsight.avgSleepDeepLaterEating} vs {mealTimingSleepInsight.avgSleepDeepEarlierEating} min
                  </span>
                  <span style={{ fontWeight: '700', color: mealTimingSleepInsight.sleepDeepDiff < 0 ? 'var(--danger-light)' : mealTimingSleepInsight.sleepDeepDiff > 0 ? 'var(--success-light)' : '#fff' }}>
                    {mealTimingSleepInsight.sleepDeepDiff > 0 ? '+' : ''}{mealTimingSleepInsight.sleepDeepDiff} min
                  </span>
                </div>
              )}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie dowód naukowy.
            </p>
          </div>
        )}

        {/* INSIGHT (Runda 9): SAMODZIELNY TREND CIŚNIENIA KRWI */}
        {bpTrendInsight && bpTrendInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🩺 Trend ciśnienia krwi</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Średnie ciśnienie z ostatnich {bpTrendInsight.recentDays} dni vs Twoja własna baseline z poprzedzających {bpTrendInsight.baselineDays} dni.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  Skurczowe: {bpTrendInsight.avgRecentSystolic} vs {bpTrendInsight.avgBaselineSystolic} mmHg
                </span>
                <span style={{ fontWeight: '700', color: bpTrendInsight.systolicDiff > 0 ? 'var(--danger-light)' : bpTrendInsight.systolicDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                  {bpTrendInsight.systolicDiff > 0 ? '+' : ''}{bpTrendInsight.systolicDiff}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                  Rozkurczowe: {bpTrendInsight.avgRecentDiastolic} vs {bpTrendInsight.avgBaselineDiastolic} mmHg
                </span>
                <span style={{ fontWeight: '700', color: bpTrendInsight.diastolicDiff > 0 ? 'var(--danger-light)' : bpTrendInsight.diastolicDiff < 0 ? 'var(--success-light)' : '#fff' }}>
                  {bpTrendInsight.diastolicDiff > 0 ? '+' : ''}{bpTrendInsight.diastolicDiff}
                </span>
              </div>
            </div>
            {bpTrendInsight.recentCategory && bpTrendInsight.recentCategory !== 'Prawidłowe' && (
              <p style={{ fontSize: '0.74rem', color: 'var(--danger-light)', marginTop: '10px', marginBottom: 0 }}>
                ⚠️ Kategoria ostatnich odczytów: {bpTrendInsight.recentCategory} (wg uproszczonych progów AHA).
              </p>
            )}
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Porównanie dwóch średnich z Twoich danych, nie diagnoza medyczna. Skonsultuj się z lekarzem przy niepokojących odczytach.
            </p>
          </div>
        )}

        {/* INSIGHT: REALNE STREFY KARDIO Z TRENINGÓW (zmierzone tętnem, nie wzór) */}
        {hrZonesInsight && hrZonesInsight.hasEnoughData && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🔥 Realne strefy kardio z treningów</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Suma minut w strefach tętna zmierzonych podczas {hrZonesInsight.workoutsWithZoneData} treningów z ostatnich {hrZonesInsight.windowDays} dni (zegarek, nie szacowanie).
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {[
                { key: 'zone1', label: 'Strefa 1', color: '#60a5fa' },
                { key: 'zone2', label: 'Strefa 2', color: '#34d399' },
                { key: 'zone3', label: 'Strefa 3', color: '#fbbf24' },
                { key: 'zone4', label: 'Strefa 4', color: '#f87171' },
                { key: 'zone5', label: 'Strefa 5', color: '#ef4444' }
              ].map(z => {
                const mins = hrZonesInsight.zoneMinutes[z.key] || 0;
                const pct = hrZonesInsight.totalMinutes > 0 ? Math.round((mins / hrZonesInsight.totalMinutes) * 100) : 0;
                return (
                  <div key={z.key} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.78rem' }}>
                    <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: '58px' }}>{z.label}</span>
                    <div style={{ flex: 1, height: '8px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: z.color, borderRadius: '4px' }} />
                    </div>
                    <span style={{ fontWeight: '700', color: '#fff', minWidth: '54px', textAlign: 'right' }}>{mins} min</span>
                  </div>
                );
              })}
            </div>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Personalizowaną rekomendację, w jakiej strefie trenować względem Twojego celu sylwetki, znajdziesz w porównaniu z poradą AI powyżej.
            </p>
          </div>
        )}
          </>
        )}

        {/* ADAPTACYJNA KOREKTA CELU KALORYCZNEGO */}
        {calorieSuggestion && calorieSuggestion.hasEnoughData && calorieSuggestion.suggestionNeeded && (
          <div className="premium-card">
            <div className="premium-title-row">
              <span className="premium-title">🎯 Adaptacyjna korekta celu kalorycznego</span>
            </div>
            <p style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.6)', marginTop: '2px', marginBottom: '10px' }}>
              Twój zalogowany bilans i bilans wynikający z realnej zmiany wagi (ostatnie ~3 tygodnie) rozjeżdżają się.
              To zwykle oznacza niedoszacowane porcje albo nieuwzględnione podjadanie, nie błędnie ustawiony cel.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Bilans z logów</span>
                <span style={{ fontWeight: '700', color: '#fff' }}>{calorieSuggestion.loggedDailyBalance > 0 ? '+' : ''}{calorieSuggestion.loggedDailyBalance} kcal/dzień</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Bilans z realnej wagi</span>
                <span style={{ fontWeight: '700', color: '#fff' }}>{calorieSuggestion.actualDailyBalance > 0 ? '+' : ''}{calorieSuggestion.actualDailyBalance} kcal/dzień</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.78rem', marginTop: '4px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Obecny cel</span>
                <span style={{ color: '#fff' }}>{calorieSuggestion.currentTargetCalories} kcal</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.85rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Sugerowany cel</span>
                <span style={{ fontWeight: '700', color: 'var(--success-light)' }}>{calorieSuggestion.suggestedTargetCalories} kcal</span>
              </div>
            </div>
            <button
              type="button"
              className="btn-primary"
              onClick={handleApplyCalorieSuggestion}
              disabled={isApplyingCalorieSuggestion}
              style={{ marginTop: '12px', width: '100%', padding: '8px 14px', fontSize: '0.85rem' }}
            >
              {isApplyingCalorieSuggestion ? 'Zapisywanie...' : `Zastosuj cel ${calorieSuggestion.suggestedTargetCalories} kcal`}
            </button>
            <p style={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.3)', marginTop: '10px', marginBottom: 0 }}>
              Sugestia oparta na Twoich danych z ostatnich tygodni, nie porada medyczna. Zawsze możesz ustawić cel ręcznie w Aktywności.
            </p>
          </div>
        )}

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
            <div style={{ marginTop: '8px', fontSize: '0.75rem', color: 'var(--danger)' }}>
              {waterMessage}
            </div>
          )}
        </div>

        {/* SUPLEMENTY */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">💊 Suplementy</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {/* Szybki wybór suplementów 7Nutrition */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '4px' }}>
              {PRESET_SUPPLEMENTS.map((sup, idx) => {
                const active = isSupplementActive(sup);
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleToggleSupplement(sup)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      padding: '5px 10px',
                      borderRadius: '20px',
                      fontSize: '0.75rem',
                      fontWeight: '600',
                      border: '1px solid',
                      borderColor: active ? 'rgba(56, 189, 248, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                      background: active 
                        ? 'linear-gradient(135deg, rgba(56, 189, 248, 0.2) 0%, rgba(56, 189, 248, 0.05) 100%)' 
                        : 'rgba(255, 255, 255, 0.03)',
                      color: active ? '#38bdf8' : 'rgba(255, 255, 255, 0.6)',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                      boxShadow: active ? '0 0 8px rgba(56, 189, 248, 0.15)' : 'none'
                    }}
                  >
                    <span>{sup.icon}</span>
                    <span>{sup.name}</span>
                  </button>
                );
              })}
            </div>

            <textarea
              placeholder="Wpisz przyjmowane suplementy (np. Kreatyna, Omega-3, Wit. D3, Białko)..."
              value={supplementsText}
              onChange={(e) => setSupplementsText(e.target.value)}
              rows={3}
              style={{
                width: '100%',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '12px',
                color: '#fff',
                padding: '10px',
                fontSize: '0.85rem',
                resize: 'none',
                fontFamily: 'inherit'
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.75rem', color: supplementsMessage.type === 'success' ? 'var(--color-secondary)' : supplementsMessage.type === 'error' ? 'var(--danger)' : 'rgba(255,255,255,0.3)' }}>
                {supplementsMessage.text || 'Zapisz, aby AI wzięło je pod uwagę'}
              </span>
              <button
                type="button"
                className="btn-primary"
                disabled={isSavingSupplements}
                onClick={handleSaveSupplements}
                style={{ padding: '8px 16px', fontSize: '0.8rem' }}
              >
                {isSavingSupplements ? 'Zapisywanie...' : 'Zapisz'}
              </button>
            </div>

            {/* Historia suplementacji (ostatnie 7 dni) */}
            {(() => {
              const last7Days = getLast7Days(selectedDate);
              const complianceDays = last7Days.filter(day => {
                const entry = historyData.find(h => h.date === day.date);
                return entry?.supplements && entry.supplements.trim().length > 0;
              }).length;

              return (
                <div style={{ marginTop: '16px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '12px' }}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={isSupplementsHistoryOpen}
                    onClick={() => setIsSupplementsHistoryOpen(o => !o)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsSupplementsHistoryOpen(o => !o); } }}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', cursor: 'pointer' }}
                  >
                    <span style={{ fontSize: '0.8rem', color: 'rgba(255, 255, 255, 0.6)', fontWeight: '600' }}>
                      Historia suplementacji {isSupplementsHistoryOpen ? '▲' : '▼'}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--color-secondary)', background: 'rgba(16, 185, 129, 0.1)', padding: '2px 8px', borderRadius: '10px', fontWeight: '700' }}>
                      Aktywność: {complianceDays}/7 dni
                    </span>
                  </div>
                  {isSupplementsHistoryOpen && (
                  <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px' }}>
                    {last7Days.map((day, idx) => {
                      const histEntry = historyData.find(h => h.date === day.date);
                      const supsText = histEntry?.supplements || '';
                      const icons = getSupplementIconsForText(supsText);
                      const isToday = day.date === selectedDate;
                      const hasSups = icons.length > 0;

                      return (
                        <div 
                          key={idx} 
                          style={{ 
                            flex: 1, 
                            display: 'flex', 
                            flexDirection: 'column', 
                            alignItems: 'center',
                            padding: '6px 4px',
                            background: isToday ? 'rgba(56, 189, 248, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                            border: isToday ? '1px solid rgba(56, 189, 248, 0.3)' : '1px solid rgba(255, 255, 255, 0.04)',
                            borderRadius: '10px',
                            minWidth: 0,
                            cursor: 'pointer'
                          }}
                          title={supsText ? `${day.date}: ${supsText}` : `${day.date}: brak suplementów`}
                        >
                          <span style={{ fontSize: '0.65rem', color: isToday ? '#38bdf8' : 'rgba(255,255,255,0.4)', textTransform: 'capitalize' }}>
                            {day.label}
                          </span>
                          <span style={{ fontSize: '0.8rem', fontWeight: '700', color: isToday ? '#fff' : 'rgba(255,255,255,0.7)', margin: '2px 0' }}>
                            {day.dayNum}
                          </span>
                          <div style={{ 
                            display: 'flex', 
                            flexDirection: 'column', 
                            alignItems: 'center', 
                            gap: '2px', 
                            minHeight: '28px', 
                            justifyContent: 'center',
                            marginTop: '2px'
                          }}>
                            {hasSups ? (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', justifyContent: 'center' }}>
                                {icons.slice(0, 3).map((ico, i) => (
                                  <span key={i} style={{ fontSize: '0.8rem' }} title={supsText}>{ico}</span>
                                ))}
                                {icons.length > 3 && (
                                  <span style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.5)', fontWeight: 'bold' }}>+{icons.length - 3}</span>
                                )}
                              </div>
                            ) : (
                              <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.1)' }}>-</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Szczegóły ostatnich dni */}
                  {(() => {
                    const loggedDays = historyData
                      .filter(h => h.supplements && h.supplements.trim().length > 0)
                      .sort((a, b) => b.date.localeCompare(a.date)) // newest first
                      .slice(0, 3); // show last 3 entries

                    if (loggedDays.length === 0) return null;

                    return (
                      <div style={{ 
                        marginTop: '12px', 
                        display: 'flex', 
                        flexDirection: 'column', 
                        gap: '6px', 
                        background: 'rgba(255, 255, 255, 0.01)', 
                        padding: '8px 10px', 
                        borderRadius: '8px', 
                        border: '1px solid rgba(255, 255, 255, 0.03)' 
                      }}>
                        <div style={{ 
                          fontSize: '0.68rem', 
                          color: 'rgba(255, 255, 255, 0.35)', 
                          fontWeight: '700', 
                          textTransform: 'uppercase', 
                          letterSpacing: '0.05em',
                          marginBottom: '2px'
                        }}>
                          Ostatnio przyjmowane
                        </div>
                        {loggedDays.map((entry, idx) => {
                          // Bezpieczna konwersja daty bez przesunięć strefy czasowej
                          const parts = entry.date.split('-');
                          const dateObj = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
                          const formattedDate = dateObj.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
                          
                          let dayLabel = formattedDate;
                          const todayStr = selectedDate;
                          
                          // Wczoraj
                          const dateParts = selectedDate.split('-');
                          const yesterdayObj = new Date(Number(dateParts[0]), Number(dateParts[1]) - 1, Number(dateParts[2]));
                          yesterdayObj.setDate(yesterdayObj.getDate() - 1);
                          const yyyy = yesterdayObj.getFullYear();
                          const mm = String(yesterdayObj.getMonth() + 1).padStart(2, '0');
                          const dd = String(yesterdayObj.getDate()).padStart(2, '0');
                          const yesterdayStr = `${yyyy}-${mm}-${dd}`;
                          
                          if (entry.date === todayStr) {
                            dayLabel = 'Dzisiaj';
                          } else if (entry.date === yesterdayStr) {
                            dayLabel = 'Wczoraj';
                          }

                          return (
                            <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', fontSize: '0.75rem', gap: '12px' }}>
                              <span style={{ fontWeight: '700', color: 'rgba(255, 255, 255, 0.5)', flexShrink: 0 }}>{dayLabel}</span>
                              <span style={{ color: '#fff', textAlign: 'right', wordBreak: 'break-word', fontWeight: '500' }}>{entry.supplements}</span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                  </>
                  )}
                </div>
              );
            })()}
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
              {/* "Czas czuwania" ukryty, gdy sleepAwakeMins jest hardcoded na 0
                  (backend jeszcze nie liczy tej wartości z Oura) - pokazywanie
                  fałszywego "0 m" sugerowałoby realny pomiar, którego nie mamy. */}
              {sleepAwakeMins > 0 && (
                <SleepStageBar
                  label="Czas czuwania"
                  durationText={`${sleepAwakeMins} m`}
                  percentage={Math.min((sleepAwakeMins / 90) * 100, 100)}
                  typicalStart={10}
                  typicalEnd={45}
                  colorClass="awake"
                />
              )}
            </div>
          </div>
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
              <RenderProgressCircle size={92} strokeWidth={8} percentage={Math.min((eatenCalories / (targetCalories || 2000)) * 100, 100)} color="var(--color-secondary)" />
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
            // POPRAWKA (runda 4 audytu): fatRatio===0 oznacza "brak pomiaru tkanki
            // tłuszczowej" (fallback ?? 0 wyżej), a NIE "realne 0% tłuszczu" - tak
            // samo jak interpretuje to fatPercentage powyżej. Wcześniej przy braku
            // danych leanBodyMassPct wynosił 100, więc nowy użytkownik bez
            // zsynchronizowanej wagi widział w pełni wypełniony, "idealny" pierścień
            // składu ciała mimo braku jakichkolwiek danych z Withings.
            const leanBodyMassPct = (weight > 0 && fatRatio > 0) ? 100 - fatRatio : 0;

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
                      <div style={{ height: '100%', background: 'var(--success-light)', width: `${musclePercentage}%` }}></div>
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
                <span style={{ color: 'var(--success-light)', fontWeight: '600' }}>
                  {bmiValue} ({bmiCategory})
                </span>
              ) : (
                <span style={{ color: 'rgba(255,255,255,0.3)', fontWeight: '500' }}>
                  Brak danych (ustaw wzrost w Ustawieniach)
                </span>
              )}
            </div>
            {/* Ciśnienie tętnicze usunięte z tego miejsca (UX runda 7, punkt 2) - duplikowało
                osobną, pełną kartę "🩺 Ciśnienie tętnicze" pod strefami tętna, którą użytkownik
                wcześniej wyraźnie poprosił o umieszczenie w tamtym miejscu. Tu zostawiamy
                tylko BMI i pomiar obwodów, żeby nie pokazywać tej samej liczby dwa razy. */}
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

        {/* ENERGIA I AKTYWNOŚĆ DNIA - połączone z dawnej karty "Dystans i aktywność dnia"
            (UX: runda 7 - dwie sąsiadujące, tematycznie pokrewne karty w jedną, żeby
            skrócić dashboard). Dane z Oury (equivalent_walking_distance, sedentary/
            low_activity_time), Google Fit (distance.delta) albo Apple Health
            (walking_running_distance). */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">Energia i aktywność dnia</span>
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
                  <span style={{ fontSize: '0.75rem', color: batteryDelta >= 0 ? 'var(--color-secondary)' : 'var(--danger-light)', fontWeight: '700' }}>
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
                  <span style={{ fontSize: '0.75rem', fontWeight: '700', color: stressSummary === 'stressful' ? 'var(--danger-light)' : stressSummary === 'restored' ? 'var(--success-light)' : '#fbbf24' }}>
                    {stressSummaryLabels[stressSummary] || stressSummary}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '16px' }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: '1rem', fontWeight: '700', color: 'var(--danger-light)' }}>
                    {stressHighMinutes != null ? `${stressHighMinutes} min` : '-'}
                  </span>
                  <span style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)' }}>Stres dzisiaj</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: '1rem', fontWeight: '700', color: 'var(--success-light)' }}>
                    {stressRecoveryMinutes != null ? `${stressRecoveryMinutes} min` : '-'}
                  </span>
                  <span style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)' }}>Regeneracja dzisiaj</span>
                </div>
              </div>
            </div>
          )}

          {/* DYSTANS I AKTYWNOŚĆ DNIA - połączone tu z dawnej osobnej karty (UX runda 7).
              Dane z Oury (equivalent_walking_distance, sedentary/low_activity_time),
              Google Fit (distance.delta) albo Apple Health (walking_running_distance). */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '12px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '10px' }}>
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
                  {activeMinutes > 0 && <div style={{ background: 'var(--danger)', flex: activeMinutes }}></div>}
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
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate && onNavigate('trends'); } }}
              role="button"
              tabIndex={0}
              style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}
            >
              Wykresy
            </span>
          </div>
          <div className="premium-grid-2" style={{ gap: '12px' }}>
            {/* hrv/rhr mogą być null (brak pomiaru z Oura za ten dzień) - karty pokazują
                '--' i neutralny stan zamiast fałszywego "0 ms"/"0 bpm" i błędnych
                porównań (null >= 48 czy null < 61 dałyby nielogiczne wyniki). */}
            <TrendCard
              title="Zmienność rytmu zatokowego"
              valueText={hrv != null ? String(hrv) : '--'}
              unitText="ms"
              activeSegment={hrv != null && hrv >= 48 ? "right" : "middle"}
              color="blue"
              footerText={hrv == null ? "Brak danych" : hrv >= 48 ? "Wysoki > 48" : "Niski < 48"}
              status="success"
            />
            <TrendCard
              title="Spoczynkowe tętno"
              valueText={rhr != null ? String(rhr) : '--'}
              unitText="bpm"
              activeSegment={rhr != null && rhr < 61 ? "left" : "middle"}
              color="blue"
              footerText={rhr == null ? "Brak danych" : rhr < 61 ? "Niski < 61" : "Wysoki > 61"}
              status="success"
            />
            {/* Karta "Słuch" pozostaje usunięta na życzenie użytkownika - Oura nie ma
                mikrofonu, a Apple Watch/AirPods nie są jeszcze obsługiwane. Poniższe
                4 karty pokazują się tylko, gdy backend faktycznie ma dla nich realną
                wartość (Gen 3+ Oura dla SpO2, Apple Watch Series 8+/Ultra z włączoną
                metryką "Wrist Temperature" w Health Auto Export dla temperatury
                nadgarstka, Oura /daily_readiness dla odchylenia temperatury ciała) -
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
            {summary.temperature_deviation != null && (() => {
              // Wspólny próg ±0.5°C (Oura) - patrz utils/health.js, żeby nie
              // duplikować tej samej granicy w kilku komponentach.
              const tempStatus = getTemperatureStatus(summary.temperature_deviation);
              return (
                <TrendCard
                  title="Odchylenie temperatury"
                  valueText={`${summary.temperature_deviation > 0 ? '+' : ''}${summary.temperature_deviation.toFixed(2)}`}
                  unitText="°C"
                  activeSegment={summary.temperature_deviation > 0.5 ? "right" : summary.temperature_deviation < -0.5 ? "left" : "middle"}
                  color="blue"
                  footerText={tempStatus.label}
                  status={tempStatus.inRange ? "success" : "warning"}
                />
              );
            })()}
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

        {/* STREFY TĘTNA (HR ZONES) - tylko gdy mamy realny RHR, bez tego wszystkie
            zakresy byłyby liczone z fałszywym RHR=0 (patrz rhrForZones powyżej).
            Statyczna tabela referencyjna - zwinięta domyślnie (UX runda 7), bo nie
            zmienia się z dnia na dzień i nie trzeba jej widzieć od razu. */}
        {rhr != null && (
        <div className="premium-card">
          <div
            className="premium-title-row"
            role="button"
            tabIndex={0}
            aria-expanded={isHrZonesOpen}
            onClick={() => setIsHrZonesOpen(o => !o)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsHrZonesOpen(o => !o); } }}
            style={{ cursor: 'pointer' }}
          >
            <span className="premium-title">💓 Strefy Tętna (Karvonen)</span>
            <span style={{ fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.4)' }}>
              Na bazie RHR ({rhr} bpm) · {isHrZonesOpen ? 'Zwiń ▲' : 'Pokaż ▼'}
            </span>
          </div>
          {isHrZonesOpen && (
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
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--success-light)' }}>{hrZone2Min}-{hrZone2Max} bpm</span>
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
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--danger-light)' }}>{hrZone4Min}-{hrZone4Max} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>Budowanie wytrzymałości beztlenowej</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 8px', background: 'rgba(255,255,255,0.01)', borderRadius: '8px', borderLeft: '3px solid #ef4444' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#fff' }}>Strefa 5 (Maks. Wysiłek)</span>
                <span style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--danger)' }}>{hrZone5Min}-{userMaxHr} bpm</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'rgba(255, 255, 255, 0.4)' }}>Trening beztlenowy, interwały, maksymalna wydolność</span>
            </div>
          </div>
          )}
        </div>
        )}

        {/* CIŚNIENIE TĘTNICZE - przeniesione pod strefy tętna w prawej kolumnie na życzenie użytkownika */}
        <div className="premium-card">
          <div className="premium-title-row">
            <span className="premium-title">🩺 Ciśnienie tętnicze</span>
            <span className="premium-title-info">ⓘ</span>
          </div>

          {summary.blood_pressure_systolic !== null && summary.blood_pressure_systolic !== undefined ? (
            (() => {
              const sys = summary.blood_pressure_systolic;
              const dia = summary.blood_pressure_diastolic;
              let color = 'var(--success-light)';
              let label = 'Optymalne';
              if (sys >= 140 || dia >= 90) { color = 'var(--danger-light)'; label = 'Wysokie'; }
              else if (sys >= 130 || dia >= 80) { color = '#fbbf24'; label = 'Podwyższone'; }
              else if (sys >= 120) { color = '#fbbf24'; label = 'Prawidłowe wysokie'; }
              return (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', margin: '8px 0' }}>
                  <span style={{ fontSize: '2rem', fontWeight: '800', color: '#fff' }}>
                    {sys}/{dia}
                  </span>
                  <span style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)' }}>mmHg</span>
                  <span style={{ fontSize: '0.8rem', fontWeight: '700', color, marginLeft: 'auto' }}>
                    {label}
                  </span>
                </div>
              );
            })()
          ) : (
            <p style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.3)', margin: '8px 0' }}>
              Brak danych (zsynchronizuj Withings, by zobaczyć pomiar ciśnienia)
            </p>
          )}
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
                aria-label="Zamknij czat"
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

            {/* Chipy szybkich pytań (Runda 8) - pokazujemy tylko na starcie konwersacji
                (sama wiadomość powitalna AI), żeby nie zaśmiecać widoku po tym, jak
                użytkownik już zaczął rozmowę. Kliknięcie wysyła pytanie od razu,
                bez kopiowania go do pola input. */}
            {chatMessages.length === 1 && !isSendingChat && (
              <div style={{
                padding: '0 20px 14px',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '8px'
              }}>
                {[
                  'Jak wygląda mój sen w tym tygodniu?',
                  'Czy jestem blisko celu kalorycznego?',
                  'Jak moja regeneracja po ostatnim treningu?',
                  'Coś niepokojącego w moich danych?'
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => handleSendChat(null, suggestion)}
                    style={{
                      background: 'rgba(124,58,237,0.12)',
                      border: '1px solid rgba(124,58,237,0.3)',
                      color: '#c4b5fd',
                      borderRadius: '999px',
                      padding: '6px 14px',
                      fontSize: '0.76rem',
                      cursor: 'pointer'
                    }}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}

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
                aria-label="Wyślij wiadomość"
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
