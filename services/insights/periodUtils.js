const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const PERIOD_DAYS = {
  weekly: 7,
  monthly: 30,
  quarterly: 90,
  yearly: 365,
};

const startOfDayIST = (date = new Date()) => {
  const utcMs = date.getTime() + IST_OFFSET_MS;
  const istDay = new Date(utcMs);
  istDay.setUTCHours(0, 0, 0, 0);
  return new Date(istDay.getTime() - IST_OFFSET_MS);
};

const endOfDayIST = (date = new Date()) => {
  const start = startOfDayIST(date);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
};

/**
 * Returns current and previous period windows (IST-aligned days).
 */
function getPeriodWindows(period, referenceDate = new Date()) {
  const days = PERIOD_DAYS[period] || PERIOD_DAYS.weekly;
  const periodEnd = endOfDayIST(referenceDate);
  const periodStart = startOfDayIST(
    new Date(periodEnd.getTime() - (days - 1) * 24 * 60 * 60 * 1000)
  );
  const previousEnd = new Date(periodStart.getTime() - 1);
  const previousStart = startOfDayIST(
    new Date(previousEnd.getTime() - (days - 1) * 24 * 60 * 60 * 1000)
  );

  return {
    period,
    days,
    periodStart,
    periodEnd,
    previousStart,
    previousEnd,
  };
}

function toBounds(start, end) {
  return { $gte: start, $lte: end };
}

function formatDateISO(date) {
  return date.toISOString().slice(0, 10);
}

function deltaPct(current, previous) {
  if (previous == null || previous === 0) {
    if (current === 0) return 0;
    return current > 0 ? 100 : 0;
  }
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function safeRatio(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

/** Normalize 0–1 ratio or 0–100 percentage to a 0–1 ratio. */
function normalizeRateToRatio(value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  const n = Number(value);
  if (n > 1) return Math.round((n / 100) * 1000) / 1000;
  return n;
}

function formatRatePct(value) {
  const ratio = normalizeRateToRatio(value);
  if (ratio == null) return "—";
  return `${Math.round(ratio * 1000) / 10}%`;
}

module.exports = {
  IST_OFFSET_MS,
  PERIOD_DAYS,
  startOfDayIST,
  endOfDayIST,
  getPeriodWindows,
  toBounds,
  formatDateISO,
  deltaPct,
  safeRatio,
  normalizeRateToRatio,
  formatRatePct,
};
