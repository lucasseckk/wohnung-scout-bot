export function parseGermanNumber(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const cleaned = input
    .replace(/[^0-9,.-]/g, '')
    .replace(/(?!^)-/g, '');
  if (!cleaned || cleaned === '-') return undefined;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? /\./g : /,/g;
    normalized = cleaned.replace(thousandsSeparator, '').replace(decimalSeparator, '.');
  } else if (lastComma >= 0) {
    const decimals = cleaned.length - lastComma - 1;
    normalized = decimals > 0 && decimals <= 2 ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
  } else if (lastDot >= 0) {
    const decimals = cleaned.length - lastDot - 1;
    normalized = decimals === 3 && /^\d{1,3}(?:\.\d{3})+$/.test(cleaned)
      ? cleaned.replace(/\./g, '')
      : cleaned;
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}
