#ifndef MONITOR_H
#define MONITOR_H

#include "jsonbuf.h"
#include "logger.h"
#include "queue.h"

#define MONITOR_MAX_WORKERS 16

/*
 * The monitor observes the real request and completion queues through
 * their lock-held hooks and keeps the live state the dashboard needs:
 * worker activity, completion history, per-second timeline, totals,
 * and a sequence-numbered event stream for SUBSCRIBE clients.
 *
 * Hooks must be installed with monitor_init() before any thread
 * starts using the queues.
 */

void monitor_init(
    int num_workers,
    int port,
    int io_delay_ms,
    RequestQueue *request_queue,
    CompletionQueue *completion_queue
);

void monitor_connection_opened(int conn_id, const char *peer);

void monitor_connection_closed(int conn_id, const char *peer);

/* A request that was rejected before reaching the request queue. */
void monitor_request_rejected(
    int request_id,
    int operation,
    const char *filename,
    const char *tag,
    const char *status,
    const char *message
);

/* Called by the completion thread after attempting delivery. */
void monitor_completion_delivered(
    const Completion *completion,
    int delivered
);

/* Full snapshot (STATS command). */
void monitor_stats_json(JsonBuf *jb);

unsigned long long monitor_event_seq(void);

/*
 * Subscriber support.
 *
 * Waits up to timeout_ms for events newer than *cursor and appends them
 * to out as framed records:  EVENT <seq> <length>\n<json>
 * Returns the number of events appended. If the subscriber fell behind
 * the ring, a "resync" event is emitted first.
 */
int monitor_next_events(
    unsigned long long *cursor,
    JsonBuf *out,
    int timeout_ms
);

/* Prints the performance module summary (used at shutdown). */
void monitor_print_summary(void);

/* Log sink for logger_set_sink(). */
void monitor_log_sink(const LogEntry *entry);

#endif
