import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { IngestRequest, ExerciseSession, ExerciseEvent } from './types';
import { validatePayload } from './validators'
import { IdempotencyService } from './idempotencyService';
import { logMetrics } from './metrics';

admin.initializeApp();
const db = admin.firestore();
const idempotencyService = new IdempotencyService(db);

export const ingestExerciseEvent = functions
  .runWith({ timeoutSeconds: 30, memory: '512MB' })
  .https.onRequest(async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
      }

      const payload: IngestRequest = req.body;
      
      // Validate request
      const validationError = validatePayload(payload);
      if (validationError) {
        console.warn('Validation failed:', { error: validationError, payload });
        res.status(400).json({ error: validationError });
        return;
      }

      // Process with idempotency (fail-closed)
      try {
        const result = await idempotencyService.processWithIdempotency(
          payload.idempotencyKey,
          payload,
          async () => processEvent(payload)
        );

        // Log metrics
        await logMetrics('event_ingested', {
          sessionId: payload.sessionId,
          userId: payload.userId,
          eventType: payload.eventType,
          isDuplicate: !result.isNew,
          eventSequence: payload.eventSequence || 0,
          clockDriftDetected: payload._clockDriftDetected || false
        });

        res.status(200).json(result.response);
        return;
      } catch (error: any) {
        if (error.message === 'Request is already being processed') {
           res.status(409).json({ error: error.message });
           return;
        }
        console.error('Processing failed:', error);
         res.status(500).json({ error: 'Processing failed' });
         return;
      }
    } catch (error) {
      console.error('Unexpected error:', error);
       res.status(500).json({ error: 'Internal server error' });
       return;
    }
  });

async function processEvent(payload: IngestRequest): Promise<any> {
  const sessionRef = db.collection('sessions').doc(payload.sessionId);
  const eventRef = db.collection('events').doc(payload.eventId);

  return await db.runTransaction(async (transaction) => {
    // Check if event already exists
    const eventDoc = await transaction.get(eventRef);
    if (eventDoc.exists) {
      console.warn(`Event ${payload.eventId} already exists (duplicate business key)`);
      
      // Log as duplicate event (different idempotency key, same event)
      await logMetrics('duplicate_event', {
        sessionId: payload.sessionId,
        eventId: payload.eventId,
        eventType: payload.eventType
      });
      
      return { 
        status: 'already_processed', 
        sessionId: payload.sessionId,
        warning: 'Event already processed with different idempotency key'
      };
    }

    const sessionDoc = await transaction.get(sessionRef);
    let session: ExerciseSession;
    let isNewSession = false;
    let outOfOrder = false;
    
    if (!sessionDoc.exists) {
      if (payload.eventType !== 'start') {
        throw new Error('Cannot create session without start event');
      }
      
      session = createNewSession(payload);
      isNewSession = true;
      // Use set with merge: false - will fail at commit if exists
      transaction.set(sessionRef, session, { merge: false });
    } else {
      session = sessionDoc.data() as ExerciseSession;
      
      // Check for out-of-order events
      const eventTime = new Date(payload.timestamp);
      
      // Sequence-based out-of-order detection
      if (payload.eventSequence && session.lastEventSequence) {
        if (payload.eventSequence <= session.lastEventSequence) {
          outOfOrder = true;
          session.requiresReconciliation = true;
          session.reconciliationReason = 'out_of_order';
          console.warn(`Out-of-order event detected by sequence: ${payload.eventSequence} <= ${session.lastEventSequence}`);
        }
      }
      
      // Time-based out-of-order detection
      if (session.lastEventTime && eventTime < new Date(session.lastEventTime)) {
        outOfOrder = true;
        session.requiresReconciliation = true;
        session.reconciliationReason = 'out_of_order';
        console.warn(`Out-of-order event detected by time: ${eventTime} < ${session.lastEventTime}`);
      }
      
      // Update metrics only if not out of order
      if (!outOfOrder) {
        session = updateSessionMetrics(session, payload);
      }
      
      // Always update tracking fields
      session.lastEventSequence = Math.max(
        session.lastEventSequence || 0,
        payload.eventSequence || 0
      );
      
      if (!session.lastEventTime || eventTime > new Date(session.lastEventTime)) {
        session.lastEventTime = eventTime;
      }
      
      transaction.set(sessionRef, session);
    }

    // Mark for reconciliation if clock drift detected
    if (payload._requiresReconciliation && !session.requiresReconciliation) {
      session.requiresReconciliation = true;
      session.reconciliationReason = 'clock_drift';
    }

    // Create event record
    const event: ExerciseEvent = {
      eventId: payload.eventId,
      sessionId: payload.sessionId,
      userId: payload.userId,
      timestamp: new Date(payload.timestamp),
      type: payload.eventType,
      metrics: payload.metrics,
      clientTimestamp: new Date(payload.timestamp),
      serverTimestamp: admin.firestore.FieldValue.serverTimestamp() as any,
      eventSequence: payload.eventSequence || 0,
      schemaVersion: 1,
      outOfOrder,
      clockDriftDetected: payload._clockDriftDetected
    };

    transaction.set(eventRef, event);

    return {
      status: 'success',
      sessionId: session.sessionId,
      sessionStatus: session.status,
      currentMetrics: {
        duration: session.metrics.totalDuration,
        calories: session.metrics.caloriesBurned,
        distance: session.metrics.distance,
        avgHeartRate: session.metrics.heartRateAvg
      },
      requiresReconciliation: session.requiresReconciliation,
      outOfOrder
    };
  });
}

export function createNewSession(payload: IngestRequest): ExerciseSession {
  const eventTime = new Date(payload.timestamp);
  const now = admin.firestore.FieldValue.serverTimestamp();
  
  return {
    sessionId: payload.sessionId,
    userId: payload.userId,
    startTime: eventTime,
    lastUpdated: now as any,
    lastEventTime: eventTime,
    lastEventSequence: payload.eventSequence || 0,
    version: 1,
    metrics: {
      totalDuration: 0,
      caloriesBurned: payload.metrics?.calories || 0,
      distance: payload.metrics?.distance || 0,
      heartRateAvg: payload.metrics?.heartRate,
      heartRateDataPoints: payload.metrics?.heartRate ? Math.max(payload.metrics?.duration || 1, 1) : 0
    },
    status: 'active'
  };
}

export function updateSessionMetrics(
  session: ExerciseSession,
  payload: IngestRequest
): ExerciseSession {
  const eventTime = new Date(payload.timestamp);
  
  // Handle start events
  if (payload.eventType === 'start') {
    if (!session.startTime || eventTime < new Date(session.startTime)) {
      session.startTime = eventTime;
    }
  }
  
  // Handle end events
  if (payload.eventType === 'end') {
    if (!session.endTime || eventTime > new Date(session.endTime)) {
      session.endTime = eventTime;
    }
    session.status = 'completed';
  }

  // Safe metric aggregation
  if (payload.metrics) {
    // Calories: Delta values (accumulated)
    if (typeof payload.metrics.calories === 'number' && payload.metrics.calories >= 0) {
      session.metrics.caloriesBurned += payload.metrics.calories;
    }
    
    // Distance: Absolute value (monotonic maximum)
    if (typeof payload.metrics.distance === 'number' && payload.metrics.distance >= 0) {
      session.metrics.distance = Math.max(
        session.metrics.distance || 0,
        payload.metrics.distance
      );
    }
    
    // Heart Rate: Safe weighted average with guards
    if (typeof payload.metrics.heartRate === 'number' && 
        payload.metrics.heartRate > 0 &&
        payload.metrics.heartRate <= 250) {
      
      const duration = Math.max(payload.metrics.duration || 1, 1); // Minimum 1 second
      const currentWeight = session.metrics.heartRateDataPoints || 0;
      const currentAvg = session.metrics.heartRateAvg || payload.metrics.heartRate;
      
      const totalWeight = currentWeight + duration;
      if (totalWeight > 0) {
        session.metrics.heartRateAvg = 
          (currentAvg * currentWeight + payload.metrics.heartRate * duration) / totalWeight;
        session.metrics.heartRateDataPoints = totalWeight;
      }
    }
  }

  // Recalculate duration
  if (session.endTime) {
    session.metrics.totalDuration = 
      (new Date(session.endTime).getTime() - new Date(session.startTime).getTime()) / 1000;
  } else {
    session.metrics.totalDuration = 
      (Date.now() - new Date(session.startTime).getTime()) / 1000;
  }

  session.lastUpdated = admin.firestore.FieldValue.serverTimestamp() as any;
  session.version += 1;

  return session;
}