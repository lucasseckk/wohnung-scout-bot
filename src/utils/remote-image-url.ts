export function normalizeRemoteImageUrl(
  rawValue: string | undefined,
  baseUrl?: string
): string | undefined {
  const value = rawValue?.trim().replace(/&amp;/gi, '&');
  if (!value || value.length > 2048) return undefined;

  const candidate = value.startsWith('//') ? `https:${value}` : value;
  try {
    const url = baseUrl ? new URL(candidate, baseUrl) : new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}
