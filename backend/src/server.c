/*
 * ASYNC FILE SERVER
 *
 * Evolved from server_multi_async_workers.c:
 *   - 4 worker threads consume the request queue
 *   - 1 completion thread delivers framed responses
 *   - every client connection is served by its own thread
 *
 * PROTOCOL (newline terminated requests, framed responses)
 *
 *   Requests (unchanged):
 *     READ <filename>\n
 *     WRITE <filename> <data>\n
 *     EXIT\n
 *
 *   Requests (new):
 *     WRITEB <filename> <length>\n<length raw bytes>   binary-safe write
 *     CREATE <filename>\n                              create empty file
 *     LIST\n | STATS\n | LOGS [n]\n | PING\n            monitoring (JSON)
 *     SUBSCRIBE\n                                      live event stream
 *
 *     Any request may be prefixed with "@<tag> " so a client can
 *     correlate pipelined responses: "@ui-17 READ notes.txt\n"
 *
 *   Responses:
 *     RESP <request_id> <payload_length> <status> [<tag>]\n<payload>
 *
 *     status is OK or an error code (ENOENT, EEXIST, EINVAL, ...).
 *     Older clients that parse "RESP %d %zu" keep working because the
 *     extra fields come after the two they read.
 *
 *   Event stream (after SUBSCRIBE):
 *     EVENT <seq> <length>\n<json>
 */

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <ctype.h>
#include <dirent.h>
#include <signal.h>
#include <pthread.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>

#include "performance.h"
#include "queue.h"
#include "logger.h"
#include "monitor.h"
#include "jsonbuf.h"

#define DEFAULT_PORT 8080
#define BUFFER_SIZE 4096                    /* max request line */
#define NUM_WORKERS 4
#define FILES_DIR "files"
#define MAX_VALID_FILENAME 128
#define MAX_READ_BYTES  (16 * 1024 * 1024)
#define MAX_WRITE_BYTES (8 * 1024 * 1024)
#define MAX_CONNECTIONS 256
#define SEND_TIMEOUT_SECONDS 10
#define READER_CAPACITY 16384

RequestQueue request_queue;
CompletionQueue completion_queue;

static int files_dirfd = -1;
static int io_delay_ms = 0;
static int request_counter = 1;
static int connection_counter = 0;
static int open_connections = 0;
/* Written by the signal handler, read by every thread: use atomics. */
static int stop_requested = 0;

#define STOP_REQUESTED() __atomic_load_n(&stop_requested, __ATOMIC_RELAXED)


/* =========================================
   CLIENT CONNECTIONS

   A connection is reference counted: its reader thread holds one
   reference and every queued request holds one. The socket is closed
   only when the last reference is released, so a completion can never
   be delivered to a recycled file descriptor that now belongs to a
   different client.
   ========================================= */

typedef struct Connection {

    int fd;

    int id;

    char peer[64];

    int refcount;

    /* Set after EXIT or a failed send; later responses are dropped. */
    int closed;

    /* Set once the connection sent a file request (for logging). */
    int announced;

    pthread_mutex_t ref_lock;

    /* Serializes frames so concurrent senders never interleave bytes. */
    pthread_mutex_t send_lock;

} Connection;


static void conn_acquire(Connection *conn)
{
    pthread_mutex_lock(&conn->ref_lock);
    conn->refcount++;
    pthread_mutex_unlock(&conn->ref_lock);
}


static void conn_release(Connection *conn)
{
    pthread_mutex_lock(&conn->ref_lock);
    int last = --conn->refcount == 0;
    pthread_mutex_unlock(&conn->ref_lock);

    if (!last)
        return;

    close(conn->fd);
    pthread_mutex_destroy(&conn->ref_lock);
    pthread_mutex_destroy(&conn->send_lock);
    free(conn);

    __atomic_sub_fetch(&open_connections, 1, __ATOMIC_SEQ_CST);
}


/* =========================================
   SEND ALL BYTES
   ========================================= */

int send_all(int fd, const char *data, size_t length)
{
    size_t sent = 0;

    while (sent < length)
    {
        /* MSG_NOSIGNAL: a vanished client must not kill the server. */
        ssize_t n = send(fd, data + sent, length - sent, MSG_NOSIGNAL);

        if (n < 0 && errno == EINTR)
            continue;

        if (n <= 0)
            return -1;

        sent += (size_t)n;
    }

    return 0;
}


/* =========================================
   SEND FRAMED RESPONSE
   Protocol:
   RESP <request_id> <payload_length> <status> [<tag>]\n
   <payload bytes>
   ========================================= */

int send_framed_response(
    Connection *conn,
    int request_id,
    const char *status,
    const char *tag,
    const char *payload,
    size_t payload_length
)
{
    char header[160];

    int header_length;

    if (tag != NULL && tag[0] != '\0')
    {
        header_length = snprintf(
            header,
            sizeof(header),
            "RESP %d %zu %s %s\n",
            request_id,
            payload_length,
            status,
            tag
        );
    }
    else
    {
        header_length = snprintf(
            header,
            sizeof(header),
            "RESP %d %zu %s\n",
            request_id,
            payload_length,
            status
        );
    }

    pthread_mutex_lock(&conn->send_lock);

    int result = 0;

    if (conn->closed)
    {
        result = -1;
    }
    else if (header_length <= 0 ||
             send_all(conn->fd, header, (size_t)header_length) < 0 ||
             (payload_length > 0 &&
              send_all(conn->fd, payload, payload_length) < 0))
    {
        /* A partial frame cannot be recovered: stop using the socket. */
        conn->closed = 1;
        shutdown(conn->fd, SHUT_RDWR);
        result = -1;
    }

    pthread_mutex_unlock(&conn->send_lock);

    return result;
}


static int send_text(Connection *conn, int request_id, const char *status,
                     const char *tag, const char *text)
{
    return send_framed_response(conn, request_id, status, tag, text, strlen(text));
}


/* =========================================
   BUFFERED SOCKET READER
   ========================================= */

typedef struct {

    int fd;

    char buffer[READER_CAPACITY];

    size_t start;

    size_t end;

} Reader;


static ssize_t reader_fill(Reader *r)
{
    if (r->start > 0)
    {
        memmove(r->buffer, r->buffer + r->start, r->end - r->start);
        r->end -= r->start;
        r->start = 0;
    }

    ssize_t n;

    do
    {
        n = recv(r->fd, r->buffer + r->end, sizeof(r->buffer) - r->end, 0);
    }
    while (n < 0 && errno == EINTR);

    if (n > 0)
        r->end += (size_t)n;

    return n;
}


/*
 * TCP is a byte stream, so one recv() may contain several requests or
 * only part of one. Requests are therefore terminated by '\n'.
 *
 * Returns 1 for a line, 0 on EOF, -1 on error, -2 if the line was longer
 * than out_size (the whole line is consumed and discarded).
 */
static int reader_line(Reader *r, char *out, size_t out_size, size_t *out_len)
{
    int discarding = 0;

    while (1)
    {
        char *newline = memchr(r->buffer + r->start, '\n', r->end - r->start);

        if (newline != NULL)
        {
            size_t line_len = (size_t)(newline - (r->buffer + r->start));
            size_t consumed = line_len + 1;

            if (discarding)
            {
                r->start += consumed;
                return -2;
            }

            /* Remove optional '\r' for CRLF clients. */
            if (line_len > 0 && r->buffer[r->start + line_len - 1] == '\r')
                line_len--;

            if (line_len >= out_size)
            {
                r->start += consumed;
                return -2;
            }

            memcpy(out, r->buffer + r->start, line_len);
            out[line_len] = '\0';
            *out_len = line_len;
            r->start += consumed;
            return 1;
        }

        if (r->end - r->start >= out_size)
        {
            /* Oversized line: drop what we have and skip to its end. */
            discarding = 1;
            r->start = r->end;
        }

        ssize_t n = reader_fill(r);

        if (n == 0)
            return 0;

        if (n < 0)
            return -1;
    }
}


/* Reads exactly length bytes (used for WRITEB payloads). */
static int reader_exact(Reader *r, char *out, size_t length)
{
    size_t buffered = r->end - r->start;
    size_t take = buffered < length ? buffered : length;

    memcpy(out, r->buffer + r->start, take);
    r->start += take;

    size_t received = take;

    while (received < length)
    {
        ssize_t n = recv(r->fd, out + received, length - received, 0);

        if (n < 0 && errno == EINTR)
            continue;

        if (n <= 0)
            return -1;

        received += (size_t)n;
    }

    return 0;
}


/* Skips length bytes so the stream stays synchronized. */
static int reader_discard(Reader *r, size_t length)
{
    char scratch[4096];

    while (length > 0)
    {
        size_t chunk = length < sizeof(scratch) ? length : sizeof(scratch);

        if (reader_exact(r, scratch, chunk) < 0)
            return -1;

        length -= chunk;
    }

    return 0;
}


/* =========================================
   VALIDATION
   ========================================= */

/*
 * Only plain names inside files/ are accepted: no path separators,
 * no leading dot (hidden files, "." and ".."), limited character set.
 * This is what prevents directory traversal.
 */
static int filename_is_valid(const char *name)
{
    size_t length = strlen(name);

    if (length == 0 || length > MAX_VALID_FILENAME)
        return 0;

    if (name[0] == '.')
        return 0;

    for (size_t i = 0; i < length; i++)
    {
        unsigned char c = (unsigned char)name[i];

        if (!(isalnum(c) || c == '.' || c == '_' || c == '-'))
            return 0;
    }

    return 1;
}


static int tag_is_valid(const char *tag)
{
    size_t length = strlen(tag);

    if (length == 0 || length >= MAX_TAG)
        return 0;

    for (size_t i = 0; i < length; i++)
    {
        unsigned char c = (unsigned char)tag[i];

        if (!(isalnum(c) || c == '_' || c == '-' || c == ':' || c == '.'))
            return 0;
    }

    return 1;
}


static int next_request_id(void)
{
    return __atomic_fetch_add(&request_counter, 1, __ATOMIC_SEQ_CST);
}


/* =========================================
   FILE OPERATIONS (run on worker threads)

   All paths are resolved relative to a directory descriptor for
   files/ with O_NOFOLLOW, so neither ".." nor symlinks can escape it.
   ========================================= */

typedef struct {

    int success;

    const char *status;

    const char *message;

    char *payload;

    size_t payload_length;

    long bytes;

} FileResult;


static void result_error(FileResult *result, const char *status, const char *message)
{
    result->success = 0;
    result->status = status;
    result->message = message;
}


static void result_from_errno(FileResult *result, int err, const char *fallback)
{
    switch (err)
    {
        case ENOENT:
            result_error(result, "ENOENT", "ERROR: File not found.");
            break;

        case EEXIST:
            result_error(result, "EEXIST", "ERROR: File already exists.");
            break;

        case ELOOP:
        case EACCES:
        case EPERM:
            result_error(result, "EACCES", "ERROR: Access denied.");
            break;

        case ENOSPC:
            result_error(result, "ENOSPC", "ERROR: No space left on device.");
            break;

        case EISDIR:
            result_error(result, "EINVAL", "ERROR: Not a regular file.");
            break;

        default:
            result_error(result, "EIO", fallback);
    }
}


static void file_read(const char *filename, FileResult *result)
{
    int file_fd = openat(
        files_dirfd,
        filename,
        O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK
    );

    if (file_fd < 0)
    {
        result_from_errno(result, errno, "ERROR: Could not open file.");
        return;
    }

    struct stat st;

    if (fstat(file_fd, &st) < 0)
    {
        result_from_errno(result, errno, "ERROR: Could not read file.");
        close(file_fd);
        return;
    }

    if (!S_ISREG(st.st_mode))
    {
        result_error(result, "EINVAL", "ERROR: Not a regular file.");
        close(file_fd);
        return;
    }

    if (st.st_size > MAX_READ_BYTES)
    {
        result_error(result, "ETOOBIG", "ERROR: File too large.");
        close(file_fd);
        return;
    }

    size_t capacity = (size_t)st.st_size;
    char *buffer = malloc(capacity + 1);

    if (buffer == NULL)
    {
        result_error(result, "ENOMEM", "ERROR: Out of memory.");
        close(file_fd);
        return;
    }

    /* read() may return fewer bytes than requested: loop until EOF. */
    size_t total = 0;

    while (total < capacity)
    {
        ssize_t n = read(file_fd, buffer + total, capacity - total);

        if (n < 0 && errno == EINTR)
            continue;

        if (n < 0)
        {
            free(buffer);
            close(file_fd);
            result_from_errno(result, errno, "ERROR: Could not read file.");
            return;
        }

        if (n == 0)
            break;

        total += (size_t)n;
    }

    close(file_fd);

    buffer[total] = '\0';

    result->success = 1;
    result->status = "OK";
    result->message = NULL;
    result->payload = buffer;
    result->payload_length = total;
    result->bytes = (long)total;
}


static int write_all(int fd, const char *data, size_t length)
{
    size_t written = 0;

    while (written < length)
    {
        ssize_t n = write(fd, data + written, length - written);

        if (n < 0 && errno == EINTR)
            continue;

        if (n < 0)
            return -1;

        written += (size_t)n;
    }

    return 0;
}


/*
 * Writes go to a temporary file that is renamed over the target, so a
 * concurrent READ sees either the old or the new contents, never a
 * half-written file, and two concurrent WRITEs cannot interleave.
 */
static void file_write(int request_id, const char *filename,
                       const char *data, size_t length, FileResult *result)
{
    struct stat st;

    if (fstatat(files_dirfd, filename, &st, AT_SYMLINK_NOFOLLOW) == 0 &&
        !S_ISREG(st.st_mode))
    {
        result_error(result, "EINVAL", "ERROR: Not a regular file.");
        return;
    }

    char temp_name[64];

    snprintf(temp_name, sizeof(temp_name), ".afs-tmp-%d-%d", (int)getpid(), request_id);

    int file_fd = openat(
        files_dirfd,
        temp_name,
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
        0644
    );

    if (file_fd < 0)
    {
        result_from_errno(result, errno, "ERROR: Could not open file.");
        return;
    }

    if (write_all(file_fd, data, length) < 0)
    {
        int err = errno;
        close(file_fd);
        unlinkat(files_dirfd, temp_name, 0);
        result_from_errno(result, err, "ERROR: Could not write file.");
        return;
    }

    if (close(file_fd) < 0)
    {
        int err = errno;
        unlinkat(files_dirfd, temp_name, 0);
        result_from_errno(result, err, "ERROR: Could not write file.");
        return;
    }

    if (renameat(files_dirfd, temp_name, files_dirfd, filename) < 0)
    {
        int err = errno;
        unlinkat(files_dirfd, temp_name, 0);
        result_from_errno(result, err, "ERROR: Could not write file.");
        return;
    }

    result->success = 1;
    result->status = "OK";
    result->message = "SUCCESS: File written successfully.";
    result->bytes = (long)length;
}


static void file_create(const char *filename, FileResult *result)
{
    int file_fd = openat(
        files_dirfd,
        filename,
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
        0644
    );

    if (file_fd < 0)
    {
        result_from_errno(result, errno, "ERROR: Could not create file.");
        return;
    }

    close(file_fd);

    result->success = 1;
    result->status = "OK";
    result->message = "SUCCESS: File created.";
    result->bytes = 0;
}


static void sleep_ms(int milliseconds)
{
    struct timespec ts;
    ts.tv_sec = milliseconds / 1000;
    ts.tv_nsec = (long)(milliseconds % 1000) * 1000000L;

    while (nanosleep(&ts, &ts) < 0 && errno == EINTR)
        ;
}


static long elapsed_ns_since(const struct timespec *start)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);

    return (now.tv_sec - start->tv_sec) * 1000000000L +
           (now.tv_nsec - start->tv_nsec);
}


/* =========================================
   WORKER: PROCESS FILE REQUEST
   ========================================= */

void process_request(int worker_id, FileRequest *request)
{
    Completion completion;
    PerformanceRecord performance;

    memset(&completion, 0, sizeof(completion));

    completion.request_id = request->request_id;
    completion.operation = request->operation;
    completion.client_fd = request->client_fd;
    completion.conn = request->conn;
    completion.worker_id = worker_id;
    completion.enqueued_at = request->enqueued_at;
    completion.queue_wait_ns = elapsed_ns_since(&request->enqueued_at);

    snprintf(completion.filename, sizeof(completion.filename), "%s", request->filename);
    snprintf(completion.tag, sizeof(completion.tag), "%s", request->tag);

    performance_start(
        &performance,
        request->request_id,
        request->operation
    );

    printf("\n[WORKER %d] Processing Request %d\n",
           worker_id,
           request->request_id);

    printf("[WORKER %d] File: %s\n",
           worker_id,
           request->filename);

    log_event(
        LOG_INFO,
        request->request_id,
        "WORKER %d PROCESSING REQUEST %d (%s %s)",
        worker_id,
        request->request_id,
        performance_operation_name(request->operation),
        request->filename
    );

    /*
     * Optional, explicit demo latency (--io-delay-ms). It is off by
     * default, reported in STATS and shown in the dashboard. The worker
     * is genuinely occupied for this time.
     */
    if (io_delay_ms > 0)
        sleep_ms(io_delay_ms);

    FileResult result;

    memset(&result, 0, sizeof(result));

    /* Defense in depth: validated again right before touching disk. */
    if (!filename_is_valid(request->filename))
    {
        result_error(&result, "EINVAL", "ERROR: Invalid filename.");
    }
    else if (request->operation == OP_READ)
    {
        file_read(request->filename, &result);
    }
    else if (request->operation == OP_WRITE)
    {
        file_write(
            request->request_id,
            request->filename,
            request->data ? request->data : "",
            request->data_len,
            &result
        );
    }
    else if (request->operation == OP_CREATE)
    {
        file_create(request->filename, &result);
    }
    else
    {
        result_error(&result, "EINVAL", "ERROR: Unknown operation.");
    }

    performance_end(
        &performance,
        (int)result.bytes,
        result.success
    );

    performance_print(
        &performance
    );

    completion.performance = performance;
    completion.success = result.success;

    snprintf(completion.status, sizeof(completion.status), "%s", result.status);

    if (result.payload != NULL)
    {
        completion.response = result.payload;
        completion.response_len = result.payload_length;
    }
    else
    {
        const char *message = result.message ? result.message : "";

        completion.response = strdup(message);
        completion.response_len = completion.response ? strlen(message) : 0;
    }

    if (result.success)
    {
        printf("[WORKER %d] %s completed: %ld bytes\n",
               worker_id,
               performance_operation_name(request->operation),
               result.bytes);

        log_event(
            LOG_INFO,
            request->request_id,
            "WORKER %d %s COMPLETED REQUEST %d: %ld bytes in %.3f ms",
            worker_id,
            performance_operation_name(request->operation),
            request->request_id,
            result.bytes,
            performance.elapsed_nanoseconds / 1000000.0
        );
    }
    else
    {
        printf("[WORKER %d] %s failed: %s\n",
               worker_id,
               performance_operation_name(request->operation),
               result.message);

        log_event(
            LOG_ERROR,
            request->request_id,
            "WORKER %d %s FAILED REQUEST %d: %s",
            worker_id,
            performance_operation_name(request->operation),
            request->request_id,
            result.message
        );
    }

    free(request->data);
    request->data = NULL;

    completion_enqueue(
        &completion_queue,
        completion
    );
}


/* =========================================
   WORKER THREAD
   ========================================= */

static int worker_ids[NUM_WORKERS];

void *worker_function(void *arg)
{
    int worker_id = *(int *)arg;

    printf(
        "[WORKER %d] Worker thread started.\n",
        worker_id
    );


    while (1)
    {
        FileRequest request =
            dequeue_by(&request_queue, &worker_id);


        process_request(worker_id, &request);
    }


    return NULL;
}


/* =========================================
   COMPLETION THREAD
   ========================================= */

void *completion_function(void *arg)
{
    (void)arg;

    printf(
        "[COMPLETION] Completion thread started.\n"
    );


    while (1)
    {
        Completion completion =
            completion_dequeue(
                &completion_queue
            );


        printf(
            "[COMPLETION] Processing Request %d\n",
            completion.request_id
        );

        log_event(
            LOG_INFO,
            completion.request_id,
            "COMPLETION PROCESSING REQUEST %d",
            completion.request_id
        );

        /*
         * Send final result to client. The connection stays open:
         * the same client may send more requests.
         */
        int delivered = send_framed_response(
            completion.conn,
            completion.request_id,
            completion.status,
            completion.tag,
            completion.response,
            completion.response_len
        ) == 0;

        if (delivered)
        {
            printf(
                "[COMPLETION] Request %d delivered to client.\n",
                completion.request_id
            );

            log_event(
                LOG_INFO,
                completion.request_id,
                "REQUEST %d DELIVERED TO CLIENT",
                completion.request_id
            );
        }
        else
        {
            printf(
                "[COMPLETION] Failed to send Request %d response.\n",
                completion.request_id
            );

            log_event(
                LOG_WARN,
                completion.request_id,
                "REQUEST %d NOT DELIVERED: CLIENT DISCONNECTED",
                completion.request_id
            );
        }

        monitor_completion_delivered(&completion, delivered);

        free(completion.response);
        conn_release(completion.conn);

        printf(
            "[COMPLETION] Completion queue size: %d\n",
            completion_queue_size(
                &completion_queue
            )
        );
    }


    return NULL;
}


/* =========================================
   MONITORING COMMANDS
   ========================================= */

static void list_files_json(JsonBuf *jb)
{
    /* Separate open file description: concurrent LISTs never share offsets. */
    int dir_fd = openat(files_dirfd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);

    DIR *dir = dir_fd >= 0 ? fdopendir(dir_fd) : NULL;

    if (dir == NULL)
    {
        if (dir_fd >= 0)
            close(dir_fd);

        jb_append(jb, "{\"files_dir\":\"files\",\"files\":[],\"error\":\"Could not open files directory\"}");
        return;
    }

    jb_append(jb, "{\"files_dir\":\"files\",\"files\":[");

    int first = 1;
    long long total_bytes = 0;
    int count = 0;
    struct dirent *entry;

    while ((entry = readdir(dir)) != NULL)
    {
        if (entry->d_name[0] == '.')
            continue;

        struct stat st;

        if (fstatat(files_dirfd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) < 0 ||
            !S_ISREG(st.st_mode))
            continue;

        long long modified_ms =
            (long long)st.st_mtim.tv_sec * 1000 + st.st_mtim.tv_nsec / 1000000;

        jb_append(jb, first ? "{\"name\":" : ",{\"name\":");
        jb_append_string(jb, entry->d_name, 1024);
        jb_appendf(
            jb,
            ",\"size\":%lld,\"modified\":%lld,\"accessible\":%s}",
            (long long)st.st_size,
            modified_ms,
            filename_is_valid(entry->d_name) ? "true" : "false"
        );

        first = 0;
        count++;
        total_bytes += st.st_size;
    }

    closedir(dir);

    jb_appendf(jb, "],\"count\":%d,\"total_bytes\":%lld}", count, total_bytes);
}


static int send_json(Connection *conn, const char *tag, JsonBuf *jb)
{
    if (jb->failed || jb->data == NULL)
        return send_text(conn, 0, "ENOMEM", tag, "ERROR: Out of memory.");

    return send_framed_response(conn, 0, "OK", tag, jb->data, jb->len);
}


/*
 * Turns the connection into a live event stream. Returns when the
 * subscriber disconnects or the server stops.
 */
static void run_subscriber(Connection *conn, const char *tag)
{
    unsigned long long cursor = monitor_event_seq();

    char hello[128];

    snprintf(hello, sizeof(hello), "{\"subscribed\":true,\"event_seq\":%llu}", cursor);

    if (send_text(conn, 0, "OK", tag, hello) < 0)
        return;

    JsonBuf out;
    jb_init(&out);

    int idle_ms = 0;

    while (!STOP_REQUESTED())
    {
        jb_reset(&out);

        int count = monitor_next_events(&cursor, &out, 500);

        if (count > 0)
        {
            idle_ms = 0;
        }
        else
        {
            idle_ms += 500;

            if (idle_ms >= 2000)
            {
                char beat[128];
                struct timeval tv;
                gettimeofday(&tv, NULL);

                int n = snprintf(
                    beat,
                    sizeof(beat),
                    "{\"type\":\"heartbeat\",\"ts\":%lld,\"event_seq\":%llu}",
                    (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000,
                    cursor
                );

                jb_appendf(&out, "EVENT 0 %d\n%s", n, beat);
                idle_ms = 0;
            }
        }

        if (out.len > 0)
        {
            pthread_mutex_lock(&conn->send_lock);
            int failed = out.failed || send_all(conn->fd, out.data, out.len) < 0;
            pthread_mutex_unlock(&conn->send_lock);

            if (failed)
                break;
        }

        /* Detect a subscriber that went away while the stream is idle. */
        char probe[256];
        ssize_t n = recv(conn->fd, probe, sizeof(probe), MSG_DONTWAIT);

        if (n == 0)
            break;

        if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)
            break;
    }

    jb_free(&out);
}


/* =========================================
   REQUEST HANDLING
   ========================================= */

static void announce_client(Connection *conn)
{
    if (conn->announced)
        return;

    conn->announced = 1;

    printf("[SERVER] Client connected.\n");

    log_event(LOG_INFO, 0, "CLIENT CONNECTED (conn %d, %s)", conn->id, conn->peer);
}


static void reject_request(
    Connection *conn,
    int request_id,
    int operation,
    const char *filename,
    const char *tag,
    const char *status,
    const char *message
)
{
    send_text(conn, request_id, status, tag, message);

    monitor_request_rejected(request_id, operation, filename, tag, status, message);

    log_event(LOG_WARN, request_id, "REQUEST %d REJECTED: %s", request_id, message);
}


static void submit_request(Connection *conn, FileRequest *request)
{
    conn_acquire(conn);

    request->conn = conn;
    request->conn_id = conn->id;
    request->client_fd = conn->fd;
    clock_gettime(CLOCK_MONOTONIC, &request->enqueued_at);

    int request_id = request->request_id;

    /* After enqueue the request belongs to the workers. */
    enqueue(
        &request_queue,
        *request
    );

    printf(
        "[SERVER] Request %d added to queue.\n",
        request_id
    );

    log_event(LOG_INFO, request_id, "REQUEST %d ADDED TO QUEUE", request_id);

    printf(
        "[SERVER] Request queue size: %d\n",
        queue_size(&request_queue)
    );
}


/*
 * Handles one request line. Returns 0 when the connection should end.
 *
 * IMPORTANT: file requests are not answered here. The completion
 * thread sends the response later, so one client can have many
 * requests in the queue before any response arrives.
 */
static int handle_line(Connection *conn, Reader *reader, char *line)
{
    char tag[MAX_TAG] = "";

    /* Optional correlation tag: "@<tag> <request>" */
    if (line[0] == '@')
    {
        char *space = strchr(line, ' ');

        if (space == NULL || (size_t)(space - line - 1) >= sizeof(tag))
        {
            send_text(conn, 0, "EINVAL", NULL, "ERROR: Invalid tag.");
            return 1;
        }

        memcpy(tag, line + 1, (size_t)(space - line - 1));
        tag[space - line - 1] = '\0';

        if (!tag_is_valid(tag))
        {
            send_text(conn, 0, "EINVAL", NULL, "ERROR: Invalid tag.");
            return 1;
        }

        line = space + 1;
    }

    /* ---------- Monitoring commands (answered immediately) ---------- */

    if (strcmp(line, "PING") == 0)
    {
        char pong[96];
        snprintf(pong, sizeof(pong), "{\"pong\":true,\"event_seq\":%llu}", monitor_event_seq());
        send_text(conn, 0, "OK", tag, pong);
        return 1;
    }

    if (strcmp(line, "STATS") == 0 || strcmp(line, "LIST") == 0 ||
        strncmp(line, "LOGS", 4) == 0)
    {
        JsonBuf jb;
        jb_init(&jb);

        if (line[0] == 'S')
        {
            monitor_stats_json(&jb);
        }
        else if (line[1] == 'I')
        {
            list_files_json(&jb);
        }
        else
        {
            int limit = 500;

            if (line[4] == ' ')
                limit = atoi(line + 5);

            jb_append(&jb, "{\"logs\":");
            logger_recent_json(&jb, limit);
            jb_append(&jb, "}");
        }

        send_json(conn, tag, &jb);
        jb_free(&jb);
        return 1;
    }

    if (strcmp(line, "SUBSCRIBE") == 0)
    {
        run_subscriber(conn, tag);
        return 0;
    }

    /* ---------- EXIT ---------- */

    if (strcmp(line, "EXIT") == 0)
    {
        send_text(conn, 0, "OK", tag, "Connection closed. Goodbye!");

        printf("[SERVER] Client requested exit.\n");

        log_event(LOG_INFO, 0, "CLIENT REQUESTED EXIT (conn %d)", conn->id);

        pthread_mutex_lock(&conn->send_lock);
        conn->closed = 1;
        shutdown(conn->fd, SHUT_RDWR);
        pthread_mutex_unlock(&conn->send_lock);

        return 0;
    }

    /* ---------- File requests ---------- */

    announce_client(conn);

    FileRequest request;

    memset(&request, 0, sizeof(request));

    request.request_id = next_request_id();

    printf("[SERVER] Request received: %.200s\n", line);

    if (strncmp(line, "WRITEB ", 7) == 0)
        log_event(LOG_INFO, request.request_id,
                  "REQUEST %d RECEIVED: %.300s (binary payload follows)", request.request_id, line);
    else
        log_event(LOG_INFO, request.request_id,
                  "REQUEST %d RECEIVED: %.300s", request.request_id, line);

    snprintf(request.tag, sizeof(request.tag), "%s", tag);

    /* =================================
       READ REQUEST
       ================================= */

    if (strncmp(line, "READ ", 5) == 0)
    {
        request.operation = OP_READ;

        sscanf(line + 5, "%255s", request.filename);
    }

    /* =================================
       CREATE REQUEST
       ================================= */

    else if (strncmp(line, "CREATE ", 7) == 0)
    {
        request.operation = OP_CREATE;

        sscanf(line + 7, "%255s", request.filename);
    }

    /* =================================
       WRITEB REQUEST (length prefixed)
       ================================= */

    else if (strncmp(line, "WRITEB ", 7) == 0)
    {
        request.operation = OP_WRITE;

        long long length = -1;

        if (sscanf(line + 7, "%255s %lld", request.filename, &length) != 2 || length < 0)
        {
            /* Without a valid length the stream cannot be resynchronized. */
            reject_request(conn, request.request_id, OP_WRITE, request.filename, tag,
                           "EINVAL", "ERROR: Invalid WRITEB request.");
            return 0;
        }

        if (length > MAX_WRITE_BYTES)
        {
            if (reader_discard(reader, (size_t)length) < 0)
                return 0;

            reject_request(conn, request.request_id, OP_WRITE, request.filename, tag,
                           "ETOOBIG", "ERROR: Payload too large.");
            return 1;
        }

        request.data = malloc((size_t)length + 1);

        if (request.data == NULL)
        {
            reader_discard(reader, (size_t)length);
            reject_request(conn, request.request_id, OP_WRITE, request.filename, tag,
                           "ENOMEM", "ERROR: Out of memory.");
            return 1;
        }

        if (reader_exact(reader, request.data, (size_t)length) < 0)
        {
            free(request.data);
            return 0;
        }

        request.data[length] = '\0';
        request.data_len = (size_t)length;
    }

    /* =================================
       WRITE REQUEST (single line)
       ================================= */

    else if (strncmp(line, "WRITE ", 6) == 0)
    {
        request.operation = OP_WRITE;

        char *content = line + 6;

        char *space = strchr(content, ' ');

        if (space == NULL)
        {
            reject_request(conn, request.request_id, OP_WRITE, content, tag,
                           "EINVAL", "ERROR: Invalid WRITE request.");
            return 1;
        }

        *space = '\0';

        snprintf(request.filename, sizeof(request.filename), "%s", content);

        request.data_len = strlen(space + 1);
        request.data = strdup(space + 1);

        if (request.data == NULL)
        {
            reject_request(conn, request.request_id, OP_WRITE, request.filename, tag,
                           "ENOMEM", "ERROR: Out of memory.");
            return 1;
        }
    }

    /* =================================
       UNKNOWN REQUEST
       ================================= */

    else
    {
        reject_request(conn, request.request_id, 0, "", tag,
                       "EINVAL", "ERROR: Unknown request.");
        return 1;
    }

    if (request.filename[0] == '\0')
    {
        free(request.data);
        reject_request(conn, request.request_id, request.operation, "", tag,
                       "EINVAL", "ERROR: Filename is required.");
        return 1;
    }

    if (!filename_is_valid(request.filename))
    {
        free(request.data);
        reject_request(conn, request.request_id, request.operation, request.filename, tag,
                       "EINVAL", "ERROR: Invalid filename.");
        return 1;
    }

    /* =================================
       ADD TO REQUEST QUEUE
       ================================= */

    submit_request(conn, &request);

    return 1;
}


/* =========================================
   CONNECTION THREAD
   ========================================= */

void *connection_function(void *arg)
{
    Connection *conn = arg;

    Reader *reader = malloc(sizeof(Reader));

    if (reader == NULL)
    {
        conn_release(conn);
        return NULL;
    }

    reader->fd = conn->fd;
    reader->start = 0;
    reader->end = 0;

    monitor_connection_opened(conn->id, conn->peer);

    char line[BUFFER_SIZE];

    while (!STOP_REQUESTED())
    {
        size_t line_length = 0;

        int rc = reader_line(reader, line, sizeof(line), &line_length);

        if (rc == 0 || rc == -1)
            break;

        if (rc == -2)
        {
            send_text(conn, 0, "EINVAL", NULL, "ERROR: Request is too long.");
            continue;
        }

        if (line_length == 0)
            continue;

        if (!handle_line(conn, reader, line))
            break;
    }

    free(reader);

    if (conn->announced)
    {
        printf("[SERVER] Client disconnected.\n");
        log_event(LOG_INFO, 0, "CLIENT DISCONNECTED (conn %d)", conn->id);
    }

    monitor_connection_closed(conn->id, conn->peer);

    /*
     * Pending requests keep their own references, so their responses
     * can still be delivered if the client only half-closed.
     */
    conn_release(conn);

    return NULL;
}


/* =========================================
   SIGNALS
   ========================================= */

static void handle_stop_signal(int sig)
{
    (void)sig;

    int saved_errno = errno;
    __atomic_store_n(&stop_requested, 1, __ATOMIC_RELAXED);
    errno = saved_errno;
}


static void usage(const char *program)
{
    printf("Usage: %s [--port N] [--io-delay-ms N]\n", program);
    printf("  --port N          TCP port (default %d)\n", DEFAULT_PORT);
    printf("  --io-delay-ms N   artificial per-request worker delay for demos (default 0)\n");
}


/* =========================================
   MAIN SERVER
   ========================================= */

int main(int argc, char **argv)
{
    int port = DEFAULT_PORT;

    for (int i = 1; i < argc; i++)
    {
        if (strcmp(argv[i], "--port") == 0 && i + 1 < argc)
        {
            port = atoi(argv[++i]);
        }
        else if (strcmp(argv[i], "--io-delay-ms") == 0 && i + 1 < argc)
        {
            io_delay_ms = atoi(argv[++i]);
        }
        else
        {
            usage(argv[0]);
            return strcmp(argv[i], "--help") == 0 ? 0 : 1;
        }
    }

    if (port <= 0 || port > 65535 || io_delay_ms < 0 || io_delay_ms > 10000)
    {
        usage(argv[0]);
        return 1;
    }

    /* Keep console output readable when redirected to a file. */
    setvbuf(stdout, NULL, _IOLBF, 0);

    signal(SIGPIPE, SIG_IGN);

    /* =====================================
       FILES DIRECTORY
       ===================================== */

    mkdir(FILES_DIR, 0755);
    mkdir("logs", 0755);

    files_dirfd = open(FILES_DIR, O_RDONLY | O_DIRECTORY | O_CLOEXEC);

    if (files_dirfd < 0)
    {
        perror("open files directory");
        return 1;
    }

    /* =====================================
       INITIALIZE LOGGER
       ===================================== */

    init_logger();

    /* =====================================
       INITIALIZE QUEUES + MONITOR
       ===================================== */

    queue_init(
        &request_queue
    );

    completion_queue_init(
        &completion_queue
    );

    monitor_init(NUM_WORKERS, port, io_delay_ms, &request_queue, &completion_queue);

    logger_set_sink(monitor_log_sink);

    log_message(
        "ASYNC FILE SERVER STARTED"
    );

    /*
     * Block SIGINT/SIGTERM in every thread we create so the signal is
     * delivered to the main thread and interrupts accept().
     */
    sigset_t stop_signals;
    sigemptyset(&stop_signals);
    sigaddset(&stop_signals, SIGINT);
    sigaddset(&stop_signals, SIGTERM);
    pthread_sigmask(SIG_BLOCK, &stop_signals, NULL);

    /* =====================================
       CREATE MULTIPLE WORKER THREADS
       ===================================== */

    pthread_t worker_threads[NUM_WORKERS];

    for (int i = 0; i < NUM_WORKERS; i++)
    {
        worker_ids[i] = i + 1;

        if (pthread_create(
            &worker_threads[i],
            NULL,
            worker_function,
            &worker_ids[i]
        ) != 0)
        {
            perror("pthread_create worker");
            exit(EXIT_FAILURE);
        }

        printf(
            "[SERVER] Worker thread %d created.\n",
            i + 1
        );
    }


    /* =====================================
       CREATE COMPLETION THREAD
       ===================================== */

    pthread_t completion_thread;

    if (pthread_create(
        &completion_thread,
        NULL,
        completion_function,
        NULL
    ) != 0)
    {
        perror("pthread_create");
        exit(EXIT_FAILURE);
    }


    /* =====================================
       CREATE SERVER SOCKET
       ===================================== */

    int server_fd = socket(
        AF_INET,
        SOCK_STREAM | SOCK_CLOEXEC,
        0
    );

    if (server_fd < 0)
    {
        perror("socket");
        exit(EXIT_FAILURE);
    }

    int opt = 1;

    setsockopt(
        server_fd,
        SOL_SOCKET,
        SO_REUSEADDR,
        &opt,
        sizeof(opt)
    );

    struct sockaddr_in server_addr;

    memset(&server_addr, 0, sizeof(server_addr));

    server_addr.sin_family = AF_INET;
    server_addr.sin_addr.s_addr = INADDR_ANY;
    server_addr.sin_port = htons((unsigned short)port);

    if (bind(
        server_fd,
        (struct sockaddr *)&server_addr,
        sizeof(server_addr)
    ) < 0)
    {
        perror("bind");
        close(server_fd);
        exit(EXIT_FAILURE);
    }

    if (listen(server_fd, 64) < 0)
    {
        perror("listen");
        close(server_fd);
        exit(EXIT_FAILURE);
    }

    /* Only the main thread receives stop signals; no SA_RESTART. */
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = handle_stop_signal;
    sigemptyset(&action.sa_mask);
    sigaction(SIGINT, &action, NULL);
    sigaction(SIGTERM, &action, NULL);
    pthread_sigmask(SIG_UNBLOCK, &stop_signals, NULL);

    printf("\n");
    printf("====================================\n");
    printf("     ASYNC FILE SERVER - FULL        \n");
    printf("====================================\n");
    printf("Server listening on port %d\n", port);
    printf("%d worker threads active.\n", NUM_WORKERS);
    printf("Completion thread active.\n");
    if (io_delay_ms > 0)
        printf("Demo I/O delay: %d ms per request.\n", io_delay_ms);
    printf("Waiting for clients...\n\n");


    /* =====================================
       ACCEPT CLIENTS
       ===================================== */

    while (!STOP_REQUESTED())
    {
        struct sockaddr_in client_addr;
        socklen_t client_len = sizeof(client_addr);

        int client_fd = accept4(
            server_fd,
            (struct sockaddr *)&client_addr,
            &client_len,
            SOCK_CLOEXEC
        );

        if (client_fd < 0)
        {
            if (errno != EINTR)
                perror("accept");

            continue;
        }

        if (__atomic_add_fetch(&open_connections, 1, __ATOMIC_SEQ_CST) > MAX_CONNECTIONS)
        {
            const char *message = "ERROR: Server is too busy.";
            char busy[96];
            int n = snprintf(busy, sizeof(busy), "RESP 0 %zu EBUSY\n%s", strlen(message), message);
            send_all(client_fd, busy, (size_t)n);
            close(client_fd);
            __atomic_sub_fetch(&open_connections, 1, __ATOMIC_SEQ_CST);
            continue;
        }

        /* A client that stops reading must not stall the completion thread. */
        struct timeval send_timeout = { SEND_TIMEOUT_SECONDS, 0 };
        setsockopt(client_fd, SOL_SOCKET, SO_SNDTIMEO, &send_timeout, sizeof(send_timeout));

        Connection *conn = calloc(1, sizeof(Connection));

        if (conn == NULL)
        {
            close(client_fd);
            __atomic_sub_fetch(&open_connections, 1, __ATOMIC_SEQ_CST);
            continue;
        }

        conn->fd = client_fd;
        conn->id = __atomic_add_fetch(&connection_counter, 1, __ATOMIC_SEQ_CST);
        conn->refcount = 1;
        pthread_mutex_init(&conn->ref_lock, NULL);
        pthread_mutex_init(&conn->send_lock, NULL);

        char address[INET_ADDRSTRLEN] = "?";
        inet_ntop(AF_INET, &client_addr.sin_addr, address, sizeof(address));
        snprintf(conn->peer, sizeof(conn->peer), "%s:%d", address, ntohs(client_addr.sin_port));

        pthread_t thread;
        pthread_attr_t attributes;
        pthread_attr_init(&attributes);
        pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);

        /* Threads created here must not catch stop signals either. */
        pthread_sigmask(SIG_BLOCK, &stop_signals, NULL);
        int rc = pthread_create(&thread, &attributes, connection_function, conn);
        pthread_sigmask(SIG_UNBLOCK, &stop_signals, NULL);

        pthread_attr_destroy(&attributes);

        if (rc != 0)
        {
            perror("pthread_create connection");
            conn_release(conn);
        }
    }


    /* =====================================
       SHUTDOWN
       ===================================== */

    printf("\n[SERVER] Shutting down.\n");

    close(server_fd);

    monitor_print_summary();

    log_message("ASYNC FILE SERVER STOPPED");

    close_logger();

    /*
     * Worker, completion and connection threads block indefinitely on
     * their queues/sockets; exiting the process ends them.
     */
    return 0;
}
