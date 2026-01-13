import { firestore } from 'firebase-admin';
import { IdempotencyRecord } from './types';

export class IdempotencyService {
  private readonly EXPIRY_HOURS = 24;
  private readonly PROCESSING_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
  
  constructor(private db: firestore.Firestore) {}

  async processWithIdempotency<T>(
    key: string,
    request: any,
    processor: () => Promise<T>
  ): Promise<{ isNew: boolean; response: T }> {
    const docRef = this.db.collection('idempotency').doc(key);
    
    try {
      // Atomic check-and-set using transaction
      const result = await this.db.runTransaction(async (transaction: firestore.Transaction) => {
        const doc = await transaction.get(docRef);
        
        if (doc.exists) {
          const data = doc.data() as IdempotencyRecord;
          const now = firestore.Timestamp.now();
          
          // Check expiry
          if (now < data.expiresAt) {
            if (data.status === 'completed' && data.response) {
              return { 
                isNew: false, 
                response: data.response,
                fromCache: true 
              };
            } else if (data.status === 'processing') {
              // Check if processing is stale
              const processingAge = data.processingStartedAt 
                ? now.toMillis() - data.processingStartedAt.toMillis()
                : now.toMillis() - data.createdAt.toMillis();
                
              if (processingAge > this.PROCESSING_TIMEOUT_MS) {
                console.warn(`Taking over stale processing for key: ${key} (age: ${processingAge}ms)`);
                // Continue to process as new
              } else {
                throw new Error('CONCURRENT_REQUEST');
              }
            } else if (data.status === 'failed') {
              throw new Error(`PREVIOUS_FAILED: ${data.error}`);
            }
          }
        }
        
        // Create idempotency record atomically
        const now = firestore.Timestamp.now();
        const expiresAt = firestore.Timestamp.fromMillis(
          now.toMillis() + this.EXPIRY_HOURS * 60 * 60 * 1000
        );
        
        const idempotencyRecord: IdempotencyRecord = {
          key,
          request,
          status: 'processing',
          createdAt: now,
          processingStartedAt: now,
          expiresAt
        };
        
        transaction.set(docRef, idempotencyRecord);
        return { shouldProcess: true };
      });

      // Return cached response if found
      if ('fromCache' in result && result.fromCache) {
        return { isNew: false, response: result.response };
      }

      // Process the request outside transaction
      try {
        const response = await processor();
        
        // Update with successful response
        await docRef.update({
          response,
          status: 'completed',
          completedAt: firestore.Timestamp.now()
        });
        
        return { isNew: true, response };
      } catch (error) {
        // Update with failure
        await docRef.update({
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
          failedAt: firestore.Timestamp.now()
        });
        throw error;
      }
    } catch (error) {
      // Fail closed - reject on uncertainty
      if (error instanceof Error) {
        if (error.message === 'CONCURRENT_REQUEST') {
          throw new Error('Request is already being processed');
        }
        if (error.message.startsWith('PREVIOUS_FAILED')) {
          throw new Error('Previous request failed, please retry with new idempotency key');
        }
      }
      throw error;
    }
  }
}