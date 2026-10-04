export type LocationReading = {
  latitude: number;
  longitude: number;
  /** Reported horizontal accuracy radius in metres. */
  accuracyM: number;
  /** When the device captured the reading (ISO 8601 or epoch milliseconds). */
  capturedAt: string | number;
};

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export type GeoPolicy = {
  latitude: number | null;
  longitude: number | null;
  radiusM: number;
  maxAccuracyM: number;
  maxAgeSeconds: number;
};

export type GeoFailure =
  | 'LOCATION_REQUIRED'
  | 'LOCATION_INVALID'
  | 'LOCATION_INACCURATE'
  | 'LOCATION_STALE'
  | 'OUTSIDE_GEOFENCE'
  | 'BRANCH_LOCATION_NOT_CONFIGURED';

export type GeoResult = { failures: GeoFailure[]; distanceM: number | null };

/**
 * Server-side geofence check. Client coordinates are evidence, not proof: they can be
 * spoofed on a modified device, which is why this is one check among several.
 */
export function checkLocation(reading: LocationReading | null | undefined, policy: GeoPolicy, now: Date): GeoResult {
  if (policy.latitude === null || policy.longitude === null) {
    return { failures: ['BRANCH_LOCATION_NOT_CONFIGURED'], distanceM: null };
  }
  if (!reading) return { failures: ['LOCATION_REQUIRED'], distanceM: null };

  const { latitude, longitude, accuracyM } = reading;
  const captured = new Date(reading.capturedAt).getTime();
  const finite = [latitude, longitude, accuracyM, captured].every((n) => typeof n === 'number' && Number.isFinite(n));
  if (!finite || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracyM < 0) {
    return { failures: ['LOCATION_INVALID'], distanceM: null };
  }

  const failures: GeoFailure[] = [];
  const ageSeconds = (now.getTime() - captured) / 1000;
  // Too old, or stamped in the future beyond reasonable clock skew.
  if (ageSeconds > policy.maxAgeSeconds || ageSeconds < -120) failures.push('LOCATION_STALE');
  if (accuracyM > policy.maxAccuracyM) failures.push('LOCATION_INACCURATE');
  const distanceM = haversineMeters(latitude, longitude, policy.latitude, policy.longitude);
  if (distanceM > policy.radiusM) failures.push('OUTSIDE_GEOFENCE');
  return { failures, distanceM };
}
