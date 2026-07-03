# Race Condition Analysis: JobId Collision in resume()

## Scenario
1. Execution is in WAITING_HUMAN status after a Human node pauses
2. Two concurrent `resolveReview()` calls happen on the same execution with the same review.id
3. Both get approval decisions (approved=true)

## Timeline

### T1: First resolveReview call
```
resolveReview(executionId, input1={reviewId: "review-123", approved: true})
  -> p.pendingReviews.resolve(review.id) // Sets review status to 'approved'
  -> executions.resume(executionId, review.id="review-123")
     -> execution = p.executions.get(executionId) // Status is WAITING_HUMAN
     -> if (execution.status !== 'WAITING_HUMAN') return; // PASSES - continues
     -> Fetches runs, context, rebuilds RunInput
```

### T2: Second resolveReview call (concurrent, before T1 completes)
```
resolveReview(executionId, input2={reviewId: "review-123", approved: true})
  -> Checking: review.status is now 'approved' (from T1's resolve call)
  -> return { review, alreadyResolved: true } // Line 47 guards this
```

Wait, looking at line 46-48 in human-escalation.service.ts:
```typescript
if (review.status !== 'pending') {
  return { review, alreadyResolved: true }; // idempotente: ya resuelta
}
```

This happens AFTER the resolve() call already happened in T1. So if both calls happen simultaneously:

### True Concurrent Scenario (both before either resolve call completes)
```
T1 reads: review.status = 'pending' ✓
T2 reads: review.status = 'pending' ✓ (concurrent read)
T1 calls: p.pendingReviews.resolve(review.id) 
  -> Uses updateMany with where { id, status: 'pending' }
  -> updateMany succeeds, changes status to 'approved'
T2 calls: p.pendingReviews.resolve(review.id)
  -> Uses updateMany with where { id, status: 'pending' }
  -> updateMany affects 0 rows (status is already 'approved')
  -> Returns the updated review anyway
T1 calls: executions.resume(executionId, "review-123")
  -> Gets execution, status = WAITING_HUMAN ✓
  -> queue.add('run', input, { jobId: "exec-123:resume:review-123" })
T2 calls: executions.resume(executionId, "review-123")
  -> Gets execution, status = WAITING_HUMAN ✓ (NOT updated yet!)
  -> queue.add('run', input, { jobId: "exec-123:resume:review-123" })
  -> DUPLICATE JOBID ENQUEUED!
```

## The Problem

The issue is NOT in the pendingReviews.resolve() call (that's guarded by updateMany with status check).

The real issue is the GAP between:
1. Line 113 in executions.service.ts: `if (execution.status !== 'WAITING_HUMAN') return;`
2. Line 134 in executions.service.ts: `await this.queue.add('run', input, { jobId: ... })`

The execution.status check doesn't actually change the status. So if two resume() calls run concurrently:
- Both pass the WAITING_HUMAN check
- Both proceed to queue.add()
- Both use the SAME jobId (if resumeKey is identical)
- BullMQ sees duplicate jobId

## Key Guard in pendingReviews.resolve()

Actually, looking closer at the flow:

In human-escalation.service.ts line 46-48:
```typescript
if (review.status !== 'pending') {
  return { review, alreadyResolved: true }; // idempotente: ya resuelta
}
```

And then line 54:
```typescript
const resolved = await this.p.pendingReviews.resolve(review.id, {...});
```

This resolve() uses updateMany with `where { id, status: 'pending' }`, which means only one concurrent call can successfully update.

But after line 54, both calls can independently call resume() before the first resume() has updated the execution status!

## Can this actually happen?

The ONLY way to prevent this is if executions.resume() itself updates the execution status inside a transaction with the status check. But looking at line 113:

```typescript
if (execution.status !== 'WAITING_HUMAN') return; // idempotente: ya reanudada o no suspendida
```

This is just a READ, not an UPDATE. So:

1. T1.resume() reads status = WAITING_HUMAN, continues
2. T2.resume() reads status = WAITING_HUMAN, continues  
3. T1.queue.add() with jobId = "exec-123:resume:review-123"
4. T2.queue.add() with jobId = "exec-123:resume:review-123" ← DUPLICATE

To stop this, resume() needs to:
- ATOMICALLY update execution.status while checking it equals WAITING_HUMAN
- Only proceed if the update affected 1 row

Currently it doesn't do this.
