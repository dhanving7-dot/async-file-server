/*
 * Live server monitor.
 *
 * LOCK ORDER (always acquire left to right, never the reverse):
 *
 *   request_queue.mutex -> completion_queue.mutex -> state_mutex -> event_mutex
 *   logger mutex -> event_mutex
 *
 * Queue hooks run with their queue mutex held and take state_mutex,
 * then event_mutex. Nothing in this file logs while holding a lock.
 */

#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#include "monitor.h"

#define EVENT_RING_SIZE   4096
#define EVENT_MAX_JSON    2048
#define HISTORY_SIZE      500
#define HISTORY_IN_STATS  150
#define TIMELINE_SECONDS  180
#define PREVIEW_BYTES     96
#define MAX_EVENTS_PER_WAKE 256


/* =========================================
   STATE
   ========================================= */

typedef struct
{
    int id;
    int busy;
    int request_id;
    int operation;
    char filename[MAX_FILENAME];
    char tag[MAX_TAG];
    struct timespec started;
    long long started_wall_ms;

    long processed;
    long failed;
    long long busy_ns;
    long long bytes;
    int last_request_id;

} WorkerState;


typedef struct
{
    int request_id;
    int operation;
    int worker_id;
    int success;
    int delivered;              /* -1 pending, 0 client gone, 1 delivered */
    char status[MAX_STATUS];
    char filename[MAX_FILENAME];
    char tag[MAX_TAG];
    char preview[PREVIEW_BYTES + 1];
    long long bytes;
    long processing_ns;
    long queue_wait_ns;
    long long latency_ns;
    long long completed_wall_ms;

} HistoryEntry;


typedef struct
{
    long long second;           /* epoch second this bucket represents */
    int completed;
    int failed;
    int reads;
    int writes;
    int creates;
    long long bytes;
    long long processing_ns;
    long long busy_ns;

} TimelineBucket;


typedef struct
{
    long count;
    long failed;
    long long total_ns;
    long long bytes;

} OpStats;


typedef struct
{
    unsigned long long seq;
    size_t len;
    char json[EVENT_MAX_JSON];

} EventSlot;


static pthread_mutex_t state_mutex = PTHREAD_MUTEX_INITIALIZER;

static RequestQueue *rq = NULL;
static CompletionQueue *cq = NULL;

static int worker_count = 0;
static int server_port = 0;
static int server_io_delay_ms = 0;
static struct timespec started_mono;
static long long started_wall_ms = 0;

static WorkerState workers[MONITOR_MAX_WORKERS];

static PerformanceStats performance_stats;
static OpStats op_stats[4];        /* indexed by OP_* */

static long total_received = 0;
static long total_queued = 0;
static long total_rejected = 0;
static long total_delivered = 0;
static long total_undelivered = 0;
static long long total_wait_ns = 0;
static long long total_latency_ns = 0;
static long long bytes_read = 0;
static long long bytes_written = 0;

static int active_connections = 0;
static long total_connections = 0;

static HistoryEntry history[HISTORY_SIZE];
static long history_count = 0;     /* total ever recorded */

static TimelineBucket timeline[TIMELINE_SECONDS];

static pthread_mutex_t event_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t event_cond = PTHREAD_COND_INITIALIZER;
static EventSlot *event_ring = NULL;
static unsigned long long event_seq = 0;


/* =========================================
   TIME HELPERS
   ========================================= */

static long long wall_ms(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}


static long long diff_ns(const struct timespec *a, const struct timespec *b)
{
    return (long long)(b->tv_sec - a->tv_sec) * 1000000000LL +
           (b->tv_nsec - a->tv_nsec);
}


static long long mono_since_ns(const struct timespec *start)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return diff_ns(start, &now);
}


static double ns_to_ms(long long ns)
{
    return ns / 1000000.0;
}


static const char *op_name(int op)
{
    return performance_operation_name(op);
}


/* =========================================
   EVENTS
   ========================================= */

/*
 * Publishes one event. body is a comma-separated list of JSON members
 * (without braces), or an empty string.
 */
static void emit_event(const char *type, const char *body)
{
    long long ts = wall_ms();

    pthread_mutex_lock(&event_mutex);

    unsigned long long seq = ++event_seq;
    EventSlot *slot = &event_ring[(seq - 1) % EVENT_RING_SIZE];

    int n = snprintf(
        slot->json,
        sizeof(slot->json),
        "{\"seq\":%llu,\"ts\":%lld,\"type\":\"%s\"%s%s}",
        seq,
        ts,
        type,
        body[0] ? "," : "",
        body
    );

    if (n < 0 || (size_t)n >= sizeof(slot->json))
    {
        /* Body too large: publish a valid, minimal event instead. */
        n = snprintf(
            slot->json,
            sizeof(slot->json),
            "{\"seq\":%llu,\"ts\":%lld,\"type\":\"%s\",\"truncated\":true}",
            seq,
            ts,
            type
        );
    }

    slot->seq = seq;
    slot->len = (size_t)n;

    pthread_cond_broadcast(&event_cond);

    pthread_mutex_unlock(&event_mutex);
}


unsigned long long monitor_event_seq(void)
{
    pthread_mutex_lock(&event_mutex);
    unsigned long long seq = event_seq;
    pthread_mutex_unlock(&event_mutex);
    return seq;
}


int monitor_next_events(
    unsigned long long *cursor,
    JsonBuf *out,
    int timeout_ms
)
{
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += timeout_ms / 1000;
    deadline.tv_nsec += (long)(timeout_ms % 1000) * 1000000L;

    if (deadline.tv_nsec >= 1000000000L)
    {
        deadline.tv_sec++;
        deadline.tv_nsec -= 1000000000L;
    }

    pthread_mutex_lock(&event_mutex);

    while (event_seq <= *cursor)
    {
        int rc = pthread_cond_timedwait(&event_cond, &event_mutex, &deadline);

        if (rc == ETIMEDOUT)
            break;
    }

    int appended = 0;

    if (event_seq > *cursor)
    {
        unsigned long long oldest =
            event_seq > EVENT_RING_SIZE ? event_seq - EVENT_RING_SIZE + 1 : 1;

        if (*cursor + 1 < oldest)
        {
            char json[160];
            int n = snprintf(
                json,
                sizeof(json),
                "{\"seq\":%llu,\"ts\":%lld,\"type\":\"resync\",\"missed_from\":%llu}",
                oldest - 1,
                wall_ms(),
                *cursor + 1
            );

            jb_appendf(out, "EVENT %llu %d\n%s", oldest - 1, n, json);
            *cursor = oldest - 1;
            appended++;
        }

        while (*cursor < event_seq && appended < MAX_EVENTS_PER_WAKE)
        {
            const EventSlot *slot =
                &event_ring[*cursor % EVENT_RING_SIZE];

            jb_appendf(out, "EVENT %llu %zu\n", slot->seq, slot->len);

            /* Raw append: the JSON may legitimately contain '%'. */
            jb_append(out, slot->json);

            *cursor = slot->seq;
            appended++;
        }
    }

    pthread_mutex_unlock(&event_mutex);

    return appended;
}


void monitor_log_sink(const LogEntry *entry)
{
    char message[900];
    json_escape_into(message, sizeof(message), entry->message, strlen(entry->message));

    char body[EVENT_MAX_JSON - 128];
    snprintf(
        body,
        sizeof(body),
        "\"log\":{\"seq\":%llu,\"ts\":%lld,\"level\":\"%s\",\"request_id\":%d,\"message\":%s}",
        entry->seq,
        entry->timestamp_ms,
        log_level_name(entry->level),
        entry->request_id,
        message
    );

    emit_event("log", body);
}


/* =========================================
   QUEUE HOOKS (queue mutex is held)
   ========================================= */

static void on_request_enqueue(
    void *ctx,
    const FileRequest *request,
    void *who,
    int count
)
{
    (void)ctx;
    (void)who;

    char file[MAX_FILENAME * 2 + 4];
    char tag[MAX_TAG * 2 + 4];
    json_escape_into(file, sizeof(file), request->filename, strlen(request->filename));
    json_escape_into(tag, sizeof(tag), request->tag, strlen(request->tag));

    char body[EVENT_MAX_JSON - 128];

    pthread_mutex_lock(&state_mutex);

    total_received++;
    total_queued++;

    snprintf(
        body,
        sizeof(body),
        "\"request_id\":%d,\"op\":\"%s\",\"file\":%s,\"tag\":%s,"
        "\"conn\":%d,\"bytes\":%zu,\"queue_size\":%d,\"position\":%d",
        request->request_id,
        op_name(request->operation),
        file,
        tag,
        request->conn_id,
        request->data_len,
        count,
        count
    );

    emit_event("request_queued", body);

    pthread_mutex_unlock(&state_mutex);
}


static void on_request_dequeue(
    void *ctx,
    const FileRequest *request,
    void *who,
    int count
)
{
    (void)ctx;

    int worker_id = who ? *(const int *)who : 0;

    long long wait_ns = mono_since_ns(&request->enqueued_at);

    char file[MAX_FILENAME * 2 + 4];
    char tag[MAX_TAG * 2 + 4];
    json_escape_into(file, sizeof(file), request->filename, strlen(request->filename));
    json_escape_into(tag, sizeof(tag), request->tag, strlen(request->tag));

    char body[EVENT_MAX_JSON - 128];

    pthread_mutex_lock(&state_mutex);

    if (worker_id >= 1 && worker_id <= worker_count)
    {
        WorkerState *w = &workers[worker_id - 1];

        w->busy = 1;
        w->request_id = request->request_id;
        w->operation = request->operation;
        snprintf(w->filename, sizeof(w->filename), "%s", request->filename);
        snprintf(w->tag, sizeof(w->tag), "%s", request->tag);
        clock_gettime(CLOCK_MONOTONIC, &w->started);
        w->started_wall_ms = wall_ms();
    }

    snprintf(
        body,
        sizeof(body),
        "\"request_id\":%d,\"op\":\"%s\",\"file\":%s,\"tag\":%s,"
        "\"worker\":%d,\"queue_size\":%d,\"wait_ms\":%.3f",
        request->request_id,
        op_name(request->operation),
        file,
        tag,
        worker_id,
        count,
        ns_to_ms(wait_ns)
    );

    emit_event("request_started", body);

    pthread_mutex_unlock(&state_mutex);
}


static void make_preview(const Completion *c, char *out, size_t out_size)
{
    size_t n = c->response_len < out_size - 1 ? c->response_len : out_size - 1;

    /* Do not cut a UTF-8 sequence in half. */
    if (n < c->response_len)
    {
        while (n > 0 && (((unsigned char)c->response[n]) & 0xC0) == 0x80)
            n--;
    }

    if (c->response != NULL && n > 0)
    {
        memcpy(out, c->response, n);

        /* NUL bytes would end the C string early; show them as '.' */
        for (size_t i = 0; i < n; i++)
        {
            if (out[i] == '\0')
                out[i] = '.';
        }
    }

    out[n] = '\0';
}


static void on_completion_enqueue(
    void *ctx,
    const Completion *c,
    int count
)
{
    (void)ctx;

    const PerformanceRecord *perf = &c->performance;
    long long now_ms = wall_ms();

    char preview[PREVIEW_BYTES + 1];
    make_preview(c, preview, sizeof(preview));

    char file[MAX_FILENAME * 2 + 4];
    char tag[MAX_TAG * 2 + 4];
    char preview_json[PREVIEW_BYTES * 6 + 4];
    json_escape_into(file, sizeof(file), c->filename, strlen(c->filename));
    json_escape_into(tag, sizeof(tag), c->tag, strlen(c->tag));
    json_escape_into(preview_json, sizeof(preview_json), preview, strlen(preview));

    char body[EVENT_MAX_JSON - 128];

    pthread_mutex_lock(&state_mutex);

    /* Worker becomes idle. */
    if (c->worker_id >= 1 && c->worker_id <= worker_count)
    {
        WorkerState *w = &workers[c->worker_id - 1];

        w->busy = 0;
        w->processed++;
        if (!c->success)
            w->failed++;
        w->busy_ns += perf->elapsed_nanoseconds;
        w->bytes += perf->bytes_processed;
        w->last_request_id = c->request_id;
        w->request_id = 0;
        w->filename[0] = '\0';
        w->tag[0] = '\0';
    }

    /* Aggregate statistics (performance module). */
    PerformanceRecord record = *perf;
    performance_stats_update(&performance_stats, &record);

    if (c->operation >= 1 && c->operation <= 3)
    {
        OpStats *s = &op_stats[c->operation];
        s->count++;
        if (!c->success)
            s->failed++;
        s->total_ns += perf->elapsed_nanoseconds;
        s->bytes += perf->bytes_processed;
    }

    if (c->success && c->operation == OP_READ)
        bytes_read += perf->bytes_processed;
    else if (c->success && c->operation == OP_WRITE)
        bytes_written += perf->bytes_processed;

    total_wait_ns += c->queue_wait_ns;

    /* Per-second timeline. */
    long long second = now_ms / 1000;
    TimelineBucket *b = &timeline[second % TIMELINE_SECONDS];

    if (b->second != second)
    {
        memset(b, 0, sizeof(*b));
        b->second = second;
    }

    b->completed++;
    if (!c->success)
        b->failed++;
    if (c->operation == OP_READ)
        b->reads++;
    else if (c->operation == OP_WRITE)
        b->writes++;
    else if (c->operation == OP_CREATE)
        b->creates++;
    b->bytes += perf->bytes_processed;
    b->processing_ns += perf->elapsed_nanoseconds;
    b->busy_ns += perf->elapsed_nanoseconds;

    /* History. */
    HistoryEntry *h = &history[history_count % HISTORY_SIZE];
    history_count++;

    memset(h, 0, sizeof(*h));
    h->request_id = c->request_id;
    h->operation = c->operation;
    h->worker_id = c->worker_id;
    h->success = c->success;
    h->delivered = -1;
    snprintf(h->status, sizeof(h->status), "%s", c->status);
    snprintf(h->filename, sizeof(h->filename), "%s", c->filename);
    snprintf(h->tag, sizeof(h->tag), "%s", c->tag);
    snprintf(h->preview, sizeof(h->preview), "%s", preview);
    h->bytes = perf->bytes_processed;
    h->processing_ns = perf->elapsed_nanoseconds;
    h->queue_wait_ns = c->queue_wait_ns;
    h->completed_wall_ms = now_ms;

    snprintf(
        body,
        sizeof(body),
        "\"request_id\":%d,\"op\":\"%s\",\"file\":%s,\"tag\":%s,"
        "\"worker\":%d,\"success\":%s,\"status\":\"%s\",\"bytes\":%d,"
        "\"processing_ms\":%.3f,\"wait_ms\":%.3f,"
        "\"completion_queue_size\":%d,\"result\":%s",
        c->request_id,
        op_name(c->operation),
        file,
        tag,
        c->worker_id,
        c->success ? "true" : "false",
        c->status,
        perf->bytes_processed,
        ns_to_ms(perf->elapsed_nanoseconds),
        ns_to_ms(c->queue_wait_ns),
        count,
        preview_json
    );

    emit_event("request_finished", body);

    pthread_mutex_unlock(&state_mutex);
}


static void on_completion_dequeue(
    void *ctx,
    const Completion *c,
    int count
)
{
    (void)ctx;

    char body[128];

    snprintf(
        body,
        sizeof(body),
        "\"request_id\":%d,\"completion_queue_size\":%d",
        c->request_id,
        count
    );

    pthread_mutex_lock(&state_mutex);
    emit_event("completion_dispatched", body);
    pthread_mutex_unlock(&state_mutex);
}


/* =========================================
   PUBLIC NOTIFICATIONS
   ========================================= */

void monitor_completion_delivered(
    const Completion *c,
    int delivered
)
{
    long long latency_ns = mono_since_ns(&c->enqueued_at);

    char body[256];

    pthread_mutex_lock(&state_mutex);

    if (delivered)
        total_delivered++;
    else
        total_undelivered++;

    total_latency_ns += latency_ns;

    /* Update the history entry (search newest first). */
    long scan = history_count < HISTORY_SIZE ? history_count : HISTORY_SIZE;

    for (long i = 0; i < scan; i++)
    {
        HistoryEntry *h = &history[(history_count - 1 - i) % HISTORY_SIZE];

        if (h->request_id == c->request_id)
        {
            h->delivered = delivered ? 1 : 0;
            h->latency_ns = latency_ns;
            break;
        }
    }

    snprintf(
        body,
        sizeof(body),
        "\"request_id\":%d,\"delivered\":%s,\"latency_ms\":%.3f",
        c->request_id,
        delivered ? "true" : "false",
        ns_to_ms(latency_ns)
    );

    emit_event("completion_delivered", body);

    pthread_mutex_unlock(&state_mutex);
}


void monitor_request_rejected(
    int request_id,
    int operation,
    const char *filename,
    const char *tag,
    const char *status,
    const char *message
)
{
    char file[MAX_FILENAME * 2 + 4];
    char tag_json[MAX_TAG * 2 + 4];
    char msg[256];
    json_escape_into(file, sizeof(file), filename, strlen(filename));
    json_escape_into(tag_json, sizeof(tag_json), tag, strlen(tag));
    json_escape_into(msg, sizeof(msg), message, strlen(message));

    char body[EVENT_MAX_JSON - 128];

    pthread_mutex_lock(&state_mutex);

    total_received++;
    total_rejected++;

    snprintf(
        body,
        sizeof(body),
        "\"request_id\":%d,\"op\":\"%s\",\"file\":%s,\"tag\":%s,"
        "\"status\":\"%s\",\"message\":%s",
        request_id,
        op_name(operation),
        file,
        tag_json,
        status,
        msg
    );

    emit_event("request_rejected", body);

    pthread_mutex_unlock(&state_mutex);
}


void monitor_connection_opened(int conn_id, const char *peer)
{
    char peer_json[96];
    json_escape_into(peer_json, sizeof(peer_json), peer, strlen(peer));

    char body[192];

    pthread_mutex_lock(&state_mutex);

    active_connections++;
    total_connections++;

    snprintf(
        body,
        sizeof(body),
        "\"conn\":%d,\"peer\":%s,\"active_connections\":%d",
        conn_id,
        peer_json,
        active_connections
    );

    emit_event("client_connected", body);

    pthread_mutex_unlock(&state_mutex);
}


void monitor_connection_closed(int conn_id, const char *peer)
{
    char peer_json[96];
    json_escape_into(peer_json, sizeof(peer_json), peer, strlen(peer));

    char body[192];

    pthread_mutex_lock(&state_mutex);

    if (active_connections > 0)
        active_connections--;

    snprintf(
        body,
        sizeof(body),
        "\"conn\":%d,\"peer\":%s,\"active_connections\":%d",
        conn_id,
        peer_json,
        active_connections
    );

    emit_event("client_disconnected", body);

    pthread_mutex_unlock(&state_mutex);
}


/* =========================================
   INIT
   ========================================= */

void monitor_init(
    int num_workers,
    int port,
    int io_delay_ms,
    RequestQueue *request_queue,
    CompletionQueue *completion_queue
)
{
    if (num_workers > MONITOR_MAX_WORKERS)
        num_workers = MONITOR_MAX_WORKERS;

    event_ring = calloc(EVENT_RING_SIZE, sizeof(EventSlot));

    if (event_ring == NULL)
    {
        perror("calloc event ring");
        exit(EXIT_FAILURE);
    }

    worker_count = num_workers;
    server_port = port;
    server_io_delay_ms = io_delay_ms;
    clock_gettime(CLOCK_MONOTONIC, &started_mono);
    started_wall_ms = wall_ms();

    for (int i = 0; i < num_workers; i++)
    {
        memset(&workers[i], 0, sizeof(workers[i]));
        workers[i].id = i + 1;
    }

    performance_stats_init(&performance_stats);

    rq = request_queue;
    cq = completion_queue;

    queue_set_hooks(rq, on_request_enqueue, on_request_dequeue, NULL);
    completion_queue_set_hooks(cq, on_completion_enqueue, on_completion_dequeue, NULL);
}


void monitor_print_summary(void)
{
    pthread_mutex_lock(&state_mutex);
    PerformanceStats copy = performance_stats;
    pthread_mutex_unlock(&state_mutex);

    performance_stats_print(&copy);
}


/* =========================================
   SNAPSHOT
   ========================================= */

static void append_history_entry(JsonBuf *jb, const HistoryEntry *h)
{
    jb_appendf(
        jb,
        "{\"request_id\":%d,\"op\":\"%s\",\"file\":",
        h->request_id,
        op_name(h->operation)
    );
    jb_append_string(jb, h->filename, MAX_FILENAME);
    jb_append(jb, ",\"tag\":");
    jb_append_string(jb, h->tag, MAX_TAG);
    jb_appendf(
        jb,
        ",\"worker\":%d,\"success\":%s,\"status\":\"%s\",\"bytes\":%lld,"
        "\"processing_ms\":%.3f,\"wait_ms\":%.3f,",
        h->worker_id,
        h->success ? "true" : "false",
        h->status,
        h->bytes,
        ns_to_ms(h->processing_ns),
        ns_to_ms(h->queue_wait_ns)
    );

    if (h->delivered < 0)
        jb_append(jb, "\"latency_ms\":null,\"delivered\":null,");
    else
        jb_appendf(
            jb,
            "\"latency_ms\":%.3f,\"delivered\":%s,",
            ns_to_ms(h->latency_ns),
            h->delivered ? "true" : "false"
        );

    jb_appendf(jb, "\"completed_at\":%lld,\"result\":", h->completed_wall_ms);

    jb_append_string(jb, h->preview, PREVIEW_BYTES);
    jb_append(jb, "}");
}


void monitor_stats_json(JsonBuf *jb)
{
    queue_lock(rq);
    completion_queue_lock(cq);
    pthread_mutex_lock(&state_mutex);

    long long now = wall_ms();
    long long uptime_ns = mono_since_ns(&started_mono);
    unsigned long long seq = monitor_event_seq();

    jb_appendf(
        jb,
        "{\"server\":{\"name\":\"Async File Server\",\"version\":\"2.0\","
        "\"pid\":%d,\"port\":%d,\"num_workers\":%d,\"io_delay_ms\":%d,"
        "\"started_at\":%lld,\"now\":%lld,\"uptime_ms\":%lld,"
        "\"active_connections\":%d,\"total_connections\":%ld,"
        "\"files_dir\":\"files\"},",
        (int)getpid(),
        server_port,
        worker_count,
        server_io_delay_ms,
        started_wall_ms,
        now,
        uptime_ns / 1000000,
        active_connections,
        total_connections
    );

    jb_appendf(jb, "\"event_seq\":%llu,", seq);

    /* ---- Request queue (real queue contents, in order) ---- */
    jb_appendf(jb, "\"queues\":{\"request_queue_size\":%d,\"request_queue\":[", rq->count);

    int position = 1;

    for (RequestNode *n = rq->front; n != NULL; n = n->next, position++)
    {
        const FileRequest *r = &n->request;

        if (position > 1)
            jb_append(jb, ",");

        jb_appendf(
            jb,
            "{\"request_id\":%d,\"op\":\"%s\",\"position\":%d,\"bytes\":%zu,"
            "\"wait_ms\":%.3f,\"status\":\"QUEUED\",\"file\":",
            r->request_id,
            op_name(r->operation),
            position,
            r->data_len,
            ns_to_ms(mono_since_ns(&r->enqueued_at))
        );
        jb_append_string(jb, r->filename, MAX_FILENAME);
        jb_append(jb, ",\"tag\":");
        jb_append_string(jb, r->tag, MAX_TAG);
        jb_append(jb, "}");
    }

    jb_appendf(jb, "],\"completion_queue_size\":%d,\"completion_queue\":[", cq->count);

    position = 1;

    for (CompletionNode *n = cq->front; n != NULL; n = n->next, position++)
    {
        const Completion *c = &n->completion;

        if (position > 1)
            jb_append(jb, ",");

        jb_appendf(
            jb,
            "{\"request_id\":%d,\"op\":\"%s\",\"position\":%d,\"success\":%s,"
            "\"status\":\"%s\",\"file\":",
            c->request_id,
            op_name(c->operation),
            position,
            c->success ? "true" : "false",
            c->status
        );
        jb_append_string(jb, c->filename, MAX_FILENAME);
        jb_append(jb, "}");
    }

    jb_append(jb, "]},");

    /* ---- Workers ---- */
    jb_append(jb, "\"workers\":[");

    for (int i = 0; i < worker_count; i++)
    {
        const WorkerState *w = &workers[i];

        long long busy_ns = w->busy_ns;
        long long elapsed_ns = 0;

        if (w->busy)
        {
            elapsed_ns = mono_since_ns(&w->started);
            busy_ns += elapsed_ns;
        }

        double utilization =
            uptime_ns > 0 ? (double)busy_ns / (double)uptime_ns : 0.0;

        if (i > 0)
            jb_append(jb, ",");

        jb_appendf(
            jb,
            "{\"id\":%d,\"state\":\"%s\",\"request_id\":%d,\"op\":%s%s%s,"
            "\"started_at\":%lld,\"elapsed_ms\":%.3f,\"processed\":%ld,"
            "\"failed\":%ld,\"busy_ms\":%.3f,\"bytes\":%lld,"
            "\"utilization\":%.6f,\"last_request_id\":%d,\"file\":",
            w->id,
            w->busy ? "PROCESSING" : "IDLE",
            w->busy ? w->request_id : 0,
            w->busy ? "\"" : "",
            w->busy ? op_name(w->operation) : "null",
            w->busy ? "\"" : "",
            w->busy ? w->started_wall_ms : 0,
            ns_to_ms(elapsed_ns),
            w->processed,
            w->failed,
            ns_to_ms(busy_ns),
            w->bytes,
            utilization,
            w->last_request_id
        );

        if (w->busy)
            jb_append_string(jb, w->filename, MAX_FILENAME);
        else
            jb_append(jb, "null");

        jb_append(jb, ",\"tag\":");
        jb_append_string(jb, w->tag, MAX_TAG);
        jb_append(jb, "}");
    }

    jb_append(jb, "],");

    /* ---- Totals (performance module) ---- */
    long completed = performance_stats.total_requests;
    long finished_delivery = total_delivered + total_undelivered;

    jb_appendf(
        jb,
        "\"totals\":{\"received\":%ld,\"queued\":%ld,\"completed\":%ld,"
        "\"succeeded\":%d,\"failed\":%d,\"rejected\":%ld,"
        "\"delivered\":%ld,\"undelivered\":%ld,"
        "\"bytes_processed\":%ld,\"bytes_read\":%lld,\"bytes_written\":%lld,"
        "\"avg_processing_ms\":%.4f,\"min_processing_ms\":%.4f,"
        "\"max_processing_ms\":%.4f,\"avg_wait_ms\":%.4f,"
        "\"avg_latency_ms\":%.4f,\"total_processing_ms\":%.3f},",
        total_received,
        total_queued,
        completed,
        performance_stats.successful_requests,
        performance_stats.failed_requests,
        total_rejected,
        total_delivered,
        total_undelivered,
        performance_stats.total_bytes,
        bytes_read,
        bytes_written,
        completed > 0
            ? ns_to_ms(performance_stats.total_time_nanoseconds) / completed
            : 0.0,
        ns_to_ms(performance_stats.min_time_nanoseconds),
        ns_to_ms(performance_stats.max_time_nanoseconds),
        completed > 0 ? ns_to_ms(total_wait_ns) / completed : 0.0,
        finished_delivery > 0
            ? ns_to_ms(total_latency_ns) / finished_delivery
            : 0.0,
        ns_to_ms(performance_stats.total_time_nanoseconds)
    );

    /* ---- Per-operation ---- */
    jb_append(jb, "\"by_op\":{");

    for (int op = 1; op <= 3; op++)
    {
        const OpStats *s = &op_stats[op];

        jb_appendf(
            jb,
            "%s\"%s\":{\"count\":%ld,\"failed\":%ld,\"avg_ms\":%.4f,\"bytes\":%lld}",
            op > 1 ? "," : "",
            op_name(op),
            s->count,
            s->failed,
            s->count > 0 ? ns_to_ms(s->total_ns) / s->count : 0.0,
            s->bytes
        );
    }

    jb_append(jb, "},");

    /* ---- Timeline (oldest first, empty seconds included) ---- */
    jb_append(jb, "\"timeline\":[");

    long long now_sec = now / 1000;

    for (long long sec = now_sec - TIMELINE_SECONDS + 1; sec <= now_sec; sec++)
    {
        const TimelineBucket *b = &timeline[((sec % TIMELINE_SECONDS) + TIMELINE_SECONDS) % TIMELINE_SECONDS];
        int valid = b->second == sec;

        jb_appendf(
            jb,
            "%s{\"t\":%lld,\"completed\":%d,\"failed\":%d,\"read\":%d,"
            "\"write\":%d,\"create\":%d,\"bytes\":%lld,\"processing_ms\":%.4f,"
            "\"busy_ms\":%.4f}",
            sec == now_sec - TIMELINE_SECONDS + 1 ? "" : ",",
            sec * 1000,
            valid ? b->completed : 0,
            valid ? b->failed : 0,
            valid ? b->reads : 0,
            valid ? b->writes : 0,
            valid ? b->creates : 0,
            valid ? b->bytes : 0,
            valid ? ns_to_ms(b->processing_ns) : 0.0,
            valid ? ns_to_ms(b->busy_ns) : 0.0
        );
    }

    jb_append(jb, "],");

    /* ---- Recent completions (newest first) ---- */
    jb_append(jb, "\"recent_completions\":[");

    long available = history_count < HISTORY_SIZE ? history_count : HISTORY_SIZE;
    long emit = available < HISTORY_IN_STATS ? available : HISTORY_IN_STATS;

    for (long i = 0; i < emit; i++)
    {
        const HistoryEntry *h = &history[(history_count - 1 - i) % HISTORY_SIZE];

        if (i > 0)
            jb_append(jb, ",");

        append_history_entry(jb, h);
    }

    jb_append(jb, "]}");

    pthread_mutex_unlock(&state_mutex);
    completion_queue_unlock(cq);
    queue_unlock(rq);
}
