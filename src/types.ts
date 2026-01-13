import { firestore } from 'firebase-admin';

export interface ExerciseSession {
  sessionId: string;
  userId: string;
  startTime: Date;
  endTime?: Date;
  lastUpdated: Date;
  lastReconciled?: Date;
  lastEventTime?: Date;
  lastEventSequence?: number;
  version: number;
  metrics: {
    totalDuration: number; // seconds
    caloriesBurned: number; // cumulative sum of deltas
    distance?: number; // maximum observed (absolute value)
    heartRateAvg?: number; // weighted average
    heartRateDataPoints?: number; // total seconds of heart rate data
  };
  status: 'active' | 'completed' | 'abandoned';
  requiresReconciliation?: boolean;
  reconciliationReason?: 'clock_drift' | 'out_of_order' | 'manual';
}

export interface ExerciseEvent {
  eventId: string;
  sessionId: string;
  userId: string;
  timestamp: Date;
  type: 'start' | 'update' | 'end';
  metrics?: {
    calories?: number; // Delta: calories burned since last event
    distance?: number; // Absolute: total distance at this point
    heartRate?: number; // Instantaneous reading
    duration?: number; // Seconds since last event
  };
  clientTimestamp: Date;
  serverTimestamp: Date;
  eventSequence: number;
  schemaVersion: number;
  outOfOrder?: boolean;
  clockDriftDetected?: boolean;
}

export interface IngestRequest {
  idempotencyKey: string;
  sessionId: string;
  userId: string;
  eventId: string;
  eventType: 'start' | 'update' | 'end';
  timestamp: string;
  metrics?: {
    calories?: number;
    distance?: number;
    heartRate?: number;
    duration?: number;
  };
  eventSequence?: number;
  _requiresReconciliation?: boolean;
  _clockDriftDetected?: boolean;
}

export interface IdempotencyRecord {
  key: string;
  request: any;
  response?: any;
  status: 'processing' | 'completed' | 'failed';
  error?: string;
  createdAt: firestore.Timestamp;
  processingStartedAt?: firestore.Timestamp;
  expiresAt: firestore.Timestamp;
}

export interface MetricsDashboardRequest {
  startDate: string;
  endDate: string;
}