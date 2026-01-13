import * as admin from 'firebase-admin';


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
