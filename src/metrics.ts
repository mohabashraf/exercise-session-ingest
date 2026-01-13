import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { MetricsDashboardRequest } from './types';

function createOnCallHandler<T, R>(
  handler: (data: T, context: any) => Promise<R>
) {
  // In tests / non-Firebase environments, just return the handler directly
  if (!functions?.https?.onCall) {
    return handler;
  }
  return functions.https.onCall(handler);
}

export async function logMetrics(eventName: string, data: any): Promise<void> {
  try {
    const db = admin.firestore();

    const metric = {
      timestamp: new Date().toISOString(),
      event: eventName,
      data,
      environment: process.env.FUNCTIONS_EMULATOR ? 'emulator' : 'production'
    };

    // Log to Cloud Logging
    console.log('METRIC:', JSON.stringify(metric));

    // Store aggregated metrics with sharding to prevent hotspots
    if (eventName === 'event_ingested') {
      const date = new Date().toISOString().split('T')[0];
      
      // Global daily totals (won't grow unbounded)
      const globalRef = db.collection('metrics').doc(`daily_${date}`);
      await globalRef.set({
        date,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        totals: {
          requests: admin.firestore.FieldValue.increment(1),
          duplicates: admin.firestore.FieldValue.increment(data.isDuplicate ? 1 : 0),
          clockDrift: admin.firestore.FieldValue.increment(data.clockDriftDetected ? 1 : 0),
          outOfOrder: admin.firestore.FieldValue.increment(data.outOfOrder ? 1 : 0)
        },
        byEventType: {
          [data.eventType]: admin.firestore.FieldValue.increment(1)
        }
      }, { merge: true });

      // Per-user metrics in subcollection (sharded, prevents doc size issues)
      const userRef = globalRef.collection('users').doc(data.userId);
      await userRef.set({
        userId: data.userId,
        requests: admin.firestore.FieldValue.increment(1),
        lastEventType: data.eventType,
        lastSeen: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    // Log duplicate events separately
    if (eventName === 'duplicate_event') {
      const date = new Date().toISOString().split('T')[0];
      const dupRef = db.collection('metrics')
        .doc(`daily_${date}`)
        .collection('duplicates')
        .doc();
        
      await dupRef.set({
        ...data,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  } catch (error) {
    console.warn('Failed to log metrics:', error);
  }
}

// Dashboard API endpoints
export const getMetricsDashboard = createOnCallHandler<MetricsDashboardRequest, any>(async (data, context) => {
  const db = admin.firestore();

  const { startDate, endDate } = data as MetricsDashboardRequest;
  
  const metricsQuery = db.collection('metrics')
    .where('date', '>=', startDate)
    .where('date', '<=', endDate)
    .orderBy('date', 'desc')
    .limit(30);

  const snapshot = await metricsQuery.get();
  
  const metrics = await Promise.all(snapshot.docs.map(async (doc) => {
    const data = doc.data();
    
    // Get user count from subcollection
    const userCount = await doc.ref.collection('users').count().get();
    
    return {
      date: data.date,
      totalRequests: data.totals?.requests || 0,
      uniqueUsers: userCount.data().count,
      duplicateRate: data.totals?.requests > 0 
        ? ((data.totals?.duplicates || 0) / data.totals.requests * 100)
        : 0,
      clockDriftRate: data.totals?.requests > 0
        ? ((data.totals?.clockDrift || 0) / data.totals.requests * 100)
        : 0,
      outOfOrderRate: data.totals?.requests > 0
        ? ((data.totals?.outOfOrder || 0) / data.totals.requests * 100)
        : 0,
      eventTypes: data.byEventType || {}
    };
  }));

  // Get current system health
  const activeSessionsCount = await db.collection('sessions')
    .where('status', '==', 'active')
    .count().get();

  const pendingReconciliation = await db.collection('sessions')
    .where('requiresReconciliation', '==', true)
    .count().get();

  return {
    dailyMetrics: metrics,
    systemHealth: {
      activeSessions: activeSessionsCount.data().count,
      pendingReconciliation: pendingReconciliation.data().count,
      lastUpdated: new Date().toISOString()
    },
    alerts: {
      highDuplicateRate: metrics.some(m => (m.duplicateRate) > 10),
      highClockDrift: metrics.some(m => (m.clockDriftRate) > 5),
      highOutOfOrder: metrics.some(m => (m.outOfOrderRate) > 15),
      reconciliationBacklog: pendingReconciliation.data().count > 100
    }
  };
});