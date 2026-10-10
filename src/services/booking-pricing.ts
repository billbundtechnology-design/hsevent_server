const DAY_MS = 24 * 60 * 60 * 1000;
const BASIS_POINTS = 10_000n;

const toBasisPoints = (percent: number): bigint => {
  const basisPoints = Math.round(percent * 100);
  if (
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100 ||
    Math.abs(percent - basisPoints / 100) > 1e-9
  ) {
    throw new RangeError('Percentages must be between 0 and 100 with at most two decimal places.');
  }
  return BigInt(basisPoints);
};

const percentageAmount = (amount: number, percent: number, roundUp = false): number => {
  const numerator = BigInt(amount) * toBasisPoints(percent);
  const rounded = roundUp
    ? (numerator + BASIS_POINTS - 1n) / BASIS_POINTS
    : (numerator + BASIS_POINTS / 2n) / BASIS_POINTS;
  return Number(rounded);
};

export const startedRentalPeriods = (startAt: Date, endAt: Date): number => {
  const durationMs = endAt.getTime() - startAt.getTime();
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError('Rental endAt must be after startAt.');
  }
  return Math.ceil(durationMs / DAY_MS);
};

export const calculateBookingAmounts = (
  subtotalKobo: number,
  discountPercent: number,
  taxPercent: number,
  depositPercent: number,
) => {
  if (!Number.isSafeInteger(subtotalKobo) || subtotalKobo < 0) {
    throw new RangeError('Booking amounts or percentages are outside supported bounds.');
  }
  toBasisPoints(discountPercent);
  toBasisPoints(taxPercent);
  toBasisPoints(depositPercent);
  const discountKobo = percentageAmount(subtotalKobo, discountPercent);
  const taxableKobo = subtotalKobo - discountKobo;
  const taxKobo = percentageAmount(taxableKobo, taxPercent);
  const totalKobo = taxableKobo + taxKobo;
  const requiredDepositKobo = percentageAmount(totalKobo, depositPercent, true);
  if (![discountKobo, taxKobo, totalKobo, requiredDepositKobo].every(Number.isSafeInteger)) {
    throw new RangeError('Booking total exceeds the supported amount.');
  }
  return { discountKobo, taxKobo, totalKobo, requiredDepositKobo };
};

export const calculateCancellationImpact = (
  booking: {
    eventDate: string;
    startAt?: Date | null;
    paidKobo: number;
  },
  policy: {
    cancellationCutoffHours: number;
    refundPercentBeforeCutoff: number;
    refundPercentAfterCutoff: number;
  },
  now: Date,
) => {
  if (!Number.isSafeInteger(booking.paidKobo) || booking.paidKobo < 0) {
    throw new RangeError('Paid amount is outside supported bounds.');
  }
  const eventStart = booking.startAt ?? new Date(`${booking.eventDate}T00:00:00+01:00`);
  const cutoffAt = new Date(eventStart.getTime() - policy.cancellationCutoffHours * 60 * 60 * 1000);
  const beforeCutoff = now.getTime() < cutoffAt.getTime();
  const refundPercent = beforeCutoff
    ? policy.refundPercentBeforeCutoff
    : policy.refundPercentAfterCutoff;
  return {
    cutoffAt: cutoffAt.toISOString(),
    evaluatedAt: now.toISOString(),
    refundPercent,
    eligibleRefundKobo: Math.min(
      booking.paidKobo,
      percentageAmount(booking.paidKobo, refundPercent),
    ),
    automaticRefund: false as const,
  };
};
