// All times in Eastern Time (ET) for market operations

export function nowET() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

export function toET(date) {
  return new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

export function timeStringET(date = new Date()) {
  const et = toET(date);
  const h = String(et.getHours()).padStart(2, '0');
  const m = String(et.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// Floor timestamp to nearest 15-min window key e.g. '10:15'
export function floorTo15Min(date = new Date()) {
  const et = toET(date);
  const h = et.getHours();
  const m = Math.floor(et.getMinutes() / 15) * 15;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Minutes since market open (9:30am ET)
export function minutesSinceOpen(date = new Date()) {
  const et = toET(date);
  const openMinutes = 9 * 60 + 30;
  const currentMinutes = et.getHours() * 60 + et.getMinutes();
  return currentMinutes - openMinutes;
}

// Is market currently open?
export function isMarketOpen(date = new Date()) {
  const et = toET(date);
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960; // 9:30am to 4:00pm
}

// All 15-min window keys for a trading day
export const WINDOW_KEYS = (() => {
  const keys = [];
  for (let h = 9; h <= 15; h++) {
    const startMin = h === 9 ? 30 : 0;
    const endMin = h === 15 ? 46 : 60;
    for (let m = startMin; m < endMin; m += 15) {
      keys.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return keys; // 26 windows: 09:30 through 15:45
})();

// Hours between two dates
export function hoursBetween(date1, date2) {
  return Math.abs(date2 - date1) / (1000 * 60 * 60);
}

// Today's date string YYYY-MM-DD
export function todayStr() {
  const et = nowET();
  return et.toISOString().split('T')[0];
}

// N trading days ago (approximate — doesn't account for holidays)
export function tradingDaysAgo(n) {
  const d = new Date();
  let count = 0;
  while (count < n) {
    d.setDate(d.getDate() - 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return d.toISOString().split('T')[0];
}
