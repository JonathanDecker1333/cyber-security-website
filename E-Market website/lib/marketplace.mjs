export function calculateCommission(amount, percentage) {
  if (!Number.isFinite(amount) || amount < 0) throw new TypeError("Amount must be non-negative.");
  if (!Number.isFinite(percentage) || percentage < 5 || percentage > 10) throw new RangeError("Commission must be between 5% and 10%.");
  const gross = Math.round(amount * 100);
  const commission = Math.round(gross * percentage / 100);
  return { gross: gross / 100, commission: commission / 100, vendorNet: (gross - commission) / 100 };
}
