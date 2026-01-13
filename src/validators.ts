import { IngestRequest } from './types';

export function validatePayload(payload: any): string | null {
  if (!payload || typeof payload !== 'object') {
    return 'Invalid request body';
  }

  // Required fields
  if (!payload.idempotencyKey || typeof payload.idempotencyKey !== 'string') {
    return 'Missing or invalid idempotency key';
  }
  
  if (payload.idempotencyKey.length > 128) {
    return 'Idempotency key too long (max 128 chars)';
  }
  
  if (!payload.sessionId || typeof payload.sessionId !== 'string') {
    return 'Missing or invalid session ID';
  }
  
  if (!payload.userId || typeof payload.userId !== 'string') {
    return 'Missing or invalid user ID';
  }
  
  if (!payload.eventId || typeof payload.eventId !== 'string') {
    return 'Missing or invalid event ID';
  }

  // Event type validation
  if (!['start', 'update', 'end'].includes(payload.eventType)) {
    return 'Invalid event type';
  }

  // Timestamp validation with offline-first approach
  if (!payload.timestamp || typeof payload.timestamp !== 'string') {
    return 'Missing or invalid timestamp';
  }

  const timestamp = new Date(payload.timestamp);
  if (isNaN(timestamp.getTime())) {
    return 'Invalid timestamp format';
  }

  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  const oneWeek = 7 * 24 * 60 * 60 * 1000;

  // Extreme bounds check
  if (timestamp.getTime() < now - oneWeek) {
    return 'Timestamp too old (max 1 week)';
  }
  
  if (timestamp.getTime() > now + oneHour) {
    return 'Timestamp too far in future (max 1 hour)';
  }

  // Flag for reconciliation instead of rejection for moderate clock drift
  if (timestamp.getTime() < now - oneHour) {
    payload._requiresReconciliation = true;
    payload._clockDriftDetected = true;
  }

  // Metrics validation
  if (payload.metrics) {
    if (typeof payload.metrics !== 'object') {
      return 'Invalid metrics format';
    }

    if ('calories' in payload.metrics) {
      if (typeof payload.metrics.calories !== 'number' || 
          payload.metrics.calories < 0 || 
          payload.metrics.calories > 1000) {
        return 'Invalid calories (0-1000)';
      }
    }

    if ('distance' in payload.metrics) {
      if (typeof payload.metrics.distance !== 'number' || 
          payload.metrics.distance < 0 || 
          payload.metrics.distance > 100000) {
        return 'Invalid distance (0-100km)';
      }
    }

    if ('heartRate' in payload.metrics) {
      if (typeof payload.metrics.heartRate !== 'number' || 
          payload.metrics.heartRate < 30 || 
          payload.metrics.heartRate > 250) {
        return 'Invalid heart rate (30-250)';
      }
    }

    if ('duration' in payload.metrics) {
      if (typeof payload.metrics.duration !== 'number' || 
          payload.metrics.duration < 0 || 
          payload.metrics.duration > 14400) {
        return 'Invalid duration (0-4 hours)';
      }
    }
  }

  // Event sequence validation
  if ('eventSequence' in payload) {
    if (typeof payload.eventSequence !== 'number' || 
        payload.eventSequence < 0 ||
        !Number.isInteger(payload.eventSequence)) {
      return 'Invalid event sequence';
    }
  }

  return null;
}