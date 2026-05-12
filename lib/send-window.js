// lib/send-window.js - Bepaal of een tijd binnen het verzend-venster valt
// Default: werkdagen (ma-vr) tussen 09:00 en 22:00 Europe/Amsterdam.

const WINDOW_START_HOUR = 9;   // 09:00 NL
const WINDOW_END_HOUR   = 22;  // 22:00 NL (laatste uur waarop nog verzonden mag worden = 21:xx)
const BUSINESS_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']; // Intl short-weekday en-locale

function nlTimeParts(date) {
  // Pak weekday + uur in NL-tijd via Intl (kort weekday-formaat)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(date);
  const weekday = parts.find(p => p.type === 'weekday')?.value || 'Mon';
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  return { weekday, hour };
}

function isInSendWindow(date) {
  const { weekday, hour } = nlTimeParts(date);
  if (!BUSINESS_DAYS.includes(weekday)) return false;
  return hour >= WINDOW_START_HOUR && hour < WINDOW_END_HOUR;
}

/**
 * Returneert de eerstvolgende tijd waarop verzonden mag worden.
 * - Als `date` al in venster → return date zelf.
 * - Anders schuift hij vooruit per uur tot in venster valt.
 */
function nextSendableTime(date = new Date()) {
  let cursor = new Date(date);
  if (isInSendWindow(cursor)) return cursor;
  // Schuif naar volgend uur-begin
  cursor.setUTCMinutes(0);
  cursor.setUTCSeconds(0);
  cursor.setUTCMilliseconds(0);
  for (let i = 0; i < 8 * 24; i++) { // max 8 dagen vooruit zoeken
    cursor.setUTCHours(cursor.getUTCHours() + 1);
    if (isInSendWindow(cursor)) return cursor;
  }
  return date; // fallback
}

function describeWindow() {
  return `werkdagen ma-vr ${WINDOW_START_HOUR}:00–${WINDOW_END_HOUR}:00 Europe/Amsterdam`;
}

module.exports = { isInSendWindow, nextSendableTime, describeWindow };
