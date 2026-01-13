import { ingestExerciseEvent} from '../src/ingestHandler';
import { InMemoryFirestore } from './testUtils/inMemoryFirestore';
import * as admin from 'firebase-admin';

// Mock Firebase
// Mock Firebase Admin before any imports that use it
jest.mock('firebase-admin', () => {
  const firestoreFn = jest.fn() as unknown as {
    (): any;
    FieldValue: any;
    Timestamp: any;
  };

  firestoreFn.FieldValue = {
    serverTimestamp: jest.fn(() => new Date()),
    increment: jest.fn((n: number) => n)
  };

  firestoreFn.Timestamp = {
    now: jest.fn(() => ({
      toMillis: () => Date.now(),
      toDate: () => new Date()
    })),
    fromMillis: jest.fn((ms: number) => ({
      toMillis: () => ms,
      toDate: () => new Date(ms)
    }))
  };

  return {
    initializeApp: jest.fn(),
    firestore: firestoreFn
  };
});

// Mock firebase-functions as well
jest.mock('firebase-functions', () => ({
  https: {
    onRequest: jest.fn((handler) => handler)
  },
  runWith: jest.fn(() => ({
    https: {
      onRequest: jest.fn((handler) => handler)
    }
  }))
}));



describe('Exercise Session Ingest - Production Tests', () => {
  let db: InMemoryFirestore;

  beforeEach(() => {
    db = new InMemoryFirestore();
    (admin.firestore as any).mockReturnValue(db);
  });

  afterEach(() => {
    db.clear();
  });

  describe('Atomic Session Creation', () => {
    test('should handle concurrent session starts correctly', async () => {
      const sessionId = 'concurrent-session-123';
      
      // Simulate two concurrent start requests
      const request1 = createTestRequest({
        idempotencyKey: 'device-1-start',
        sessionId,
        eventId: 'event-device-1',
        eventType: 'start',
        eventSequence: 1
      });
      
      const request2 = createTestRequest({
        idempotencyKey: 'device-2-start',
        sessionId,
        eventId: 'event-device-2',
        eventType: 'start',
        eventSequence: 1
      });

      // Process both concurrently
      const [response1, response2] = await Promise.all([
        processRequest(request1),
        processRequest(request2)
      ]);
      
      // Both should succeed
      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
      
      // Verify session exists
      const sessionData = db.getAllData();
      const sessionKeys = Array.from(sessionData.keys()).filter(k => k.includes(`sessions/${sessionId}`));
      expect(sessionKeys).toHaveLength(1);
      
      // Verify both events were created
      const eventKeys = Array.from(sessionData.keys()).filter(k => k.includes('events/'));
      expect(eventKeys).toHaveLength(2);
    });

    test('should reject non-start events for missing sessions', async () => {
      const request = createTestRequest({
        sessionId: 'missing-session',
        eventType: 'update'
      });

      const response = await processRequest(request);
      
      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Processing failed');
    });
  });

  describe('Out-of-Order Detection', () => {
    test('should detect and flag sequence-based out-of-order events', async () => {
      const sessionId = 'ooo-sequence-test';
      
      // Create session with event sequence 3
      await processRequest(createTestRequest({
        sessionId,
        eventType: 'start',
        eventSequence: 3
      }));

      // Send earlier sequence
      const response = await processRequest(createTestRequest({
        sessionId,
        eventType: 'update',
        eventSequence: 2,
        idempotencyKey: 'ooo-2',
        eventId: 'event-ooo-2'
      }));

      expect(response.status).toBe(200);
      expect(response.body.outOfOrder).toBe(true);
      expect(response.body.requiresReconciliation).toBe(true);
      
      // Check session was flagged
      const session = await db.collection('sessions').doc(sessionId).get();
      expect(session.data().requiresReconciliation).toBe(true);
      expect(session.data().reconciliationReason).toBe('out_of_order');
    });

    test('should detect time-based out-of-order events', async () => {
      const sessionId = 'ooo-time-test';
      const futureTime = new Date();
      futureTime.setMinutes(futureTime.getMinutes() + 30);
      
      // Create session with future timestamp
      await processRequest(createTestRequest({
        sessionId,
        eventType: 'start',
        timestamp: futureTime.toISOString()
      }));

      // Send earlier timestamp
      const response = await processRequest(createTestRequest({
        sessionId,
        eventType: 'update',
        timestamp: new Date().toISOString(),
        idempotencyKey: 'ooo-past',
        eventId: 'event-ooo-past'
      }));

      expect(response.body.outOfOrder).toBe(true);
      expect(response.body.requiresReconciliation).toBe(true);
    });
  });

  describe('Metric Aggregation with Delta Semantics', () => {
    test('should accumulate calorie deltas correctly', async () => {
      const sessionId = 'calories-delta-test';
      
      // Start: 10 calories
      await processRequest(createTestRequest({
        sessionId,
        eventType: 'start',
        metrics: { calories: 10 }
      }));

      // Update: +20 calories
      await processRequest(createTestRequest({
        sessionId,
        eventType: 'update',
        metrics: { calories: 20 },
        idempotencyKey: 'cal-2',
        eventId: 'event-cal-2'
      }));

      // Update: +15 calories
      await processRequest(createTestRequest({
        sessionId,
        eventType: 'update',
        metrics: { calories: 15 },
        idempotencyKey: 'cal-3',
        eventId: 'event-cal-3'
      }));

      const session = await db.collection('sessions').doc(sessionId).get();
      expect(session.data().metrics.caloriesBurned).toBe(45); // 10+20+15
    });

    test('should use monotonic max for distance', async () => {
      const sessionId = 'distance-max-test';
      
      await processRequest(createTestRequest({
        sessionId,
        eventType: 'start',
        metrics: { distance: 1000 }
      }));

      await processRequest(createTestRequest({
        sessionId,
        eventType: 'update',
        metrics: { distance: 2500 },
        idempotencyKey: 'd-2',
        eventId: 'event-d-2'
      }));

      // GPS recalculation shows lower distance - should not decrease
      await processRequest(createTestRequest({
        sessionId,
        eventType: 'update',
        metrics: { distance: 2300 },
        idempotencyKey: 'd-3',
        eventId: 'event-d-3'
      }));

      const session = await db.collection('sessions').doc(sessionId).get();
      expect(session.data().metrics.distance).toBe(2500); // Maximum
    });
  });

  describe('Clock Drift Handling', () => {
    test('should accept and flag old timestamps', async () => {
      const oldTimestamp = new Date();
      oldTimestamp.setHours(oldTimestamp.getHours() - 2);

      const request = createTestRequest({
        sessionId: 'clock-drift-test',
        eventType: 'start',
        timestamp: oldTimestamp.toISOString()
      });

      const response = await processRequest(request);
      
      expect(response.status).toBe(200);
      expect(response.body.requiresReconciliation).toBe(true);
    });
  });

  describe('Duplicate Event Detection', () => {
    test('should handle same eventId with different idempotencyKey', async () => {
      const sessionId = 'dup-event-test';
      const eventId = 'same-event-123';
      
      // First request
      await processRequest(createTestRequest({
        sessionId,
        eventId,
        eventType: 'start',
        idempotencyKey: 'key-1'
      }));

      // Same event, different idempotency key
      const response = await processRequest(createTestRequest({
        sessionId,
        eventId,
        eventType: 'start',
        idempotencyKey: 'key-2'
      }));

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('already_processed');
      expect(response.body.warning).toContain('different idempotency key');
    });
  });

  // Helper functions
  function createTestRequest(overrides: any = {}) {
    return {
      idempotencyKey: `test-${Date.now()}-${Math.random()}`,
      sessionId: `session-${Date.now()}`,
      userId: 'test-user',
      eventId: `event-${Date.now()}-${Math.random()}`,
      eventType: 'update',
      timestamp: new Date().toISOString(),
      metrics: {
        calories: 10,
        distance: 100,
        heartRate: 120,
        duration: 60
      },
      eventSequence: 1,
      ...overrides
    };
  }

  async function processRequest(body: any) {
    const req = { method: 'POST', body };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    
    await ingestExerciseEvent(req as any, res as any);
    
    return {
      status: res.status.mock.calls[0]?.[0] || 200,
      body: res.json.mock.calls[0]?.[0]
    };
  }
});