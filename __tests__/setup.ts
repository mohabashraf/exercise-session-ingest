import * as admin from 'firebase-admin';

// Mock Firebase Admin globally
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

jest.mock('firebase-functions', () => ({
  https: {
    onRequest: jest.fn((handler) => handler),
    onCall: jest.fn((handler) => handler)
  },
  runWith: jest.fn(() => ({
    https: {
      onRequest: jest.fn((handler) => handler)
    },
    pubsub: {
      schedule: jest.fn(() => ({
        onRun: jest.fn((handler) => handler)
      }))
    }
  })),
  pubsub: {
    schedule: jest.fn(() => ({
      onRun: jest.fn((handler) => handler)
    }))
  }
}));