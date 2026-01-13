# Idempotent Exercise Session Ingest System

A production-ready, idempotent ingestion system for exercise tracking data from mobile clients, built on Firebase Functions and Firestore.

## Scope & Intent

This repository focuses on the **idempotent ingest path only**.

It intentionally keeps aggregation and reconciliation logic minimal to ensure:
- deterministic writes
- easy reasoning under retries
- strong exactly-once guarantees at the business level

In a production system, full session reconciliation and event replay would be handled asynchronously from an append-only event log, rather than in the ingest path itself.

## 🏗️ Architecture Overview

This system handles the challenging reality of mobile fitness apps:
- Network failures causing retry storms
- Offline workout syncing with clock drift  
- Out-of-order event arrival
- Concurrent session initialization

### Dual-Key Idempotency Strategy

We implement **two layers** of deduplication:

1. **`idempotencyKey` (API Gateway Level)**
   - Purpose: Protects against network-level retries
   - Example: User's phone loses connection mid-request and retries
   - Scope: HTTP request deduplication  
   - TTL: 24 hours with automatic cleanup

2. **`eventId` (Data Layer Level)**  
   - Purpose: Protects against application-logic duplicates
   - Example: App bug generates two events for one action
   - Scope: Business logic deduplication
   - TTL: Permanent (part of event history)

## 📜 Idempotency Contract

This system provides the following guarantees:

1. **Same idempotencyKey → Same response** (exactly-once semantics at API layer)
2. **Same eventId → Event processed once** (business-level deduplication)
3. **Different idempotencyKey + same eventId → No-op** (logged as duplicate_event)

### Processing State Management
- Processing requests timeout after 2 minutes to prevent eternal locks
- Failed requests can be retried with a new idempotency key
- All state transitions are logged for debugging

## 📊 Metric Semantics

**Important**: This system uses the following metric semantics:

- **Calories**: Delta values (calories burned since last event) - accumulated via sum
- **Distance**: Absolute total at time of event - uses monotonic max to prevent corruption
- **Heart Rate**: Instantaneous reading - weighted average by duration
- **Duration**: Seconds since last event - used for weighting calculations

### Why These Choices?
- **Delta calories** prevent double-counting on retries
- **Absolute distance** handles GPS recalculations gracefully
- **Weighted heart rate** gives physiologically accurate averages

## 🔄 Out-of-Order Detection

The system automatically detects and handles out-of-order events:

1. **Sequence-based**: If `eventSequence < lastEventSequence`
2. **Time-based**: If `eventTime < lastEventTime`
3. **Action**: Events are stored but session is flagged for reconciliation

Reconciliation is deliberately discussed as a follow-up concern and not implemented in this submission to keep the ingest path idempotent, bounded, and low-latency.

## 🚀 Scaling Architecture

### Current Design (Optimized for <1,000 req/sec)
- Firestore transactions provide ACID guarantees
- Perfect consistency with acceptable latency
- Cost: ~$0.10 per 100K requests

### Future Scale Path (>10,000 req/sec)
```
Mobile → API Gateway → Pub/Sub → Event Store → Stream Processor → Aggregated Views
```
- Write events to append-only log (Cloud Bigtable/Spanner)
- Compute aggregates asynchronously from event stream
- Remove incremental aggregation from write path
- Eventual consistency with sub-second lag

## 📈 What I'd Improve Next

With more time, I would:

1. **Remove incremental aggregation entirely** - Make the ingest path strictly append-only and compute all aggregates asynchronously from the event log
2. **Add event replay capability** - Allow recomputing all sessions from raw events when business rules change
3. **Implement CQRS pattern** - Separate write model (events) from read model (aggregated sessions)
4. **Add request signing** - Prevent replay attacks at the API level

## 🔍 Monitoring & Observability

### Key Metrics Tracked
- Duplicate request rate (health indicator)
- Clock drift detection rate
- Out-of-order event rate
- Processing timeout rate
- Event processing latency (P50, P95, P99)

### Sharded Metrics Storage
- Global daily totals in `metrics/daily_{date}`
- Per-user metrics in `metrics/daily_{date}/users/{userId}`
- Prevents hotspotting and document size limits

## 🏃‍♂️ Running the Project

### Local Development
```bash
npm install
npm test
npm run build
firebase emulators:start
```

### Deployment
```bash
firebase deploy --only functions
firebase deploy --only firestore:indexes
```