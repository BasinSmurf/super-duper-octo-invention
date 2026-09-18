/**
 * classproTravel.ts — geocoding + drive-time-from-shop for ClassPRO locations.
 *
 * Uses the Google Geocoding + Distance Matrix web APIs, gated on two env vars:
 *   GOOGLE_MAPS_API_KEY   — Workspace-managed key
 *   CLASSPRO_SHOP_ORIGIN  — the shop, as "lat,lng" or a street address
 *
 * Bad-divorce by design: with either missing (or Google unreachable) every
 * function returns null and callers fall back to manual entry — scheduling
 * never blocks on Google. Results are CACHED on the location row (and later
 * on sessions); nothing here is called on render paths, only on save /
 * explicit recompute, so quota burn stays bounded.
 */

const API_KEY = () => process.env.GOOGLE_MAPS_API_KEY || '';
const SHOP_ORIGIN = () => process.env.CLASSPRO_SHOP_ORIGIN || '';

/** Both env vars present — auto geocode/drive-time is on. */
export function travelAutoComputeEnabled(): boolean {
  return Boolean(API_KEY() && SHOP_ORIGIN());
}

/** Geocoding alone only needs the key. */
export function geocodeEnabled(): boolean {
  return Boolean(API_KEY());
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  formattedAddress: string;
}

export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  if (!geocodeEnabled() || !address.trim()) return null;
  try {
    const url =
      'https://maps.googleapis.com/maps/api/geocode/json' +
      `?address=${encodeURIComponent(address.trim())}&key=${API_KEY()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      status: string;
      results?: { geometry: { location: { lat: number; lng: number } }; formatted_address: string }[];
    };
    const first = body.results?.[0];
    if (body.status !== 'OK' || !first) {
      if (body.status !== 'ZERO_RESULTS') {
        console.warn(`[classproTravel] geocode status ${body.status} for "${address}"`);
      }
      return null;
    }
    return {
      lat: first.geometry.location.lat,
      lng: first.geometry.location.lng,
      formattedAddress: first.formatted_address,
    };
  } catch (err) {
    console.warn('[classproTravel] geocode failed:', (err as Error).message);
    return null;
  }
}

/** One-way drive time (minutes, rounded up) from the shop to lat/lng. */
export async function driveTimeFromShopMin(lat: number, lng: number): Promise<number | null> {
  if (!travelAutoComputeEnabled()) return null;
  try {
    const url =
      'https://maps.googleapis.com/maps/api/distancematrix/json' +
      `?origins=${encodeURIComponent(SHOP_ORIGIN())}` +
      `&destinations=${lat},${lng}&key=${API_KEY()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      status: string;
      rows?: { elements?: { status: string; duration?: { value: number } }[] }[];
    };
    const el = body.rows?.[0]?.elements?.[0];
    if (body.status !== 'OK' || el?.status !== 'OK' || !el.duration) {
      console.warn(`[classproTravel] distance matrix status ${body.status}/${el?.status ?? 'n/a'}`);
      return null;
    }
    return Math.ceil(el.duration.value / 60);
  } catch (err) {
    console.warn('[classproTravel] drive time failed:', (err as Error).message);
    return null;
  }
}

/** Full address line from structured parts, for geocoding. */
export function composeAddress(parts: { address?: string | null; city?: string | null; state?: string | null; zip?: string | null }): string {
  return [parts.address, parts.city, parts.state, parts.zip].filter(Boolean).join(', ');
}
