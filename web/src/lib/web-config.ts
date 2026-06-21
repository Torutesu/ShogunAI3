export function getAppBaseUrl(): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return base ? base.replace(/\/+$/, '') : null;
}

export function getDmgDownloadUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_DMG_DOWNLOAD_URL?.trim();
  return url ? url : null;
}

export function getRequiredEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function getAllowedLpOrigins(): string[] {
  const explicit = process.env.NEXT_PUBLIC_LP_ORIGIN?.trim();
  const origins = ['https://shogunai.lovable.app', explicit]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/\/+$/, ''));
  return Array.from(new Set(origins));
}
