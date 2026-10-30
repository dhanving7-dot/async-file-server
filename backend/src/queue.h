#ifndef QUEUE_H
#define QUEUE_H

#include <pthread.h>
#include <stddef.h>
#include <time.h>

#include "performance.h"

#define MAX_FILENAME 256
#define MAX_DATA 3500          /* legacy single-line WRITE payload limit */
#define MAX_TAG 48
#define MAX_STATUS 16

#define OP_READ   1
#define OP_WRITE  2
#define OP_CREATE 3

struct Connection;

typedef struct {

    int request_id;

    int operation;

    int client_fd;

    /* Owning client connection (reference counted). */
    struct Connection *conn;

    int conn_id;

    char filename[MAX_FILENAME];

    /* WRITE payload, heap allocated and owned by the request. */
    char *data;

    size_t data_len;

    /* Optional client supplied correlation tag ("@tag READ x"). */
    char tag[MAX_TAG];

    struct timespec enqueued_at;

} FileRequest;


typedef struct {

    int request_id;

    int operation;

    int client_fd;

    struct Connection *conn;

    int success;

    int worker_id;

    /* OK, ENOENT, EEXIST, EINVAL, EIO, ETOOBIG ... */
    char status[MAX_STATUS];

    char filename[MAX_FILENAME];

    char tag[MAX_TAG];

    /* Response payload, heap allocated and owned by the completion. */
    char *response;

    size_t response_len;

    /* Time spent waiting in the request queue. */
    long queue_wait_ns;

    struct timespec enqueued_at;

    PerformanceRecord performance;

} Completion;


typedef struct RequestNode {

    FileRequest request;

    struct RequestNode *next;

} RequestNode;


typedef struct CompletionNode {

    Completion completion;

    struct CompletionNode *next;

} CompletionNode;


/*
 * Hooks are invoked while the queue mutex is held, so an observer
 * sees enqueue/dequeue transitions in exactly the order they happen.
 * A hook must never lock the same queue again.
 *
 * who   : opaque caller context passed to dequeue_by() (e.g. worker id)
 * count : number of items in the queue after the operation
 */
typedef void (*RequestHook)(
    void *ctx,
    const FileRequest *request,
    void *who,
    int count
);

typedef void (*CompletionHook)(
    void *ctx,
    const Completion *completion,
    int count
);


typedef struct {

    RequestNode *front;

    RequestNode *rear;

    int count;

    pthread_mutex_t mutex;

    pthread_cond_t condition;

    RequestHook on_enqueue;

    RequestHook on_dequeue;

    void *hook_ctx;

} RequestQueue;


typedef struct {

    CompletionNode *front;

    CompletionNode *rear;

    int count;

    pthread_mutex_t mutex;

    pthread_cond_t condition;

    CompletionHook on_enqueue;

    CompletionHook on_dequeue;

    void *hook_ctx;

} CompletionQueue;


/* =========================
   REQUEST QUEUE
   ========================= */

void queue_init(RequestQueue *queue);

void queue_set_hooks(
    RequestQueue *queue,
    RequestHook on_enqueue,
    RequestHook on_dequeue,
    void *ctx
);

void enqueue(
    RequestQueue *queue,
    FileRequest request
);

FileRequest dequeue(
    RequestQueue *queue
);

FileRequest dequeue_by(
    RequestQueue *queue,
    void *who
);

int queue_size(
    RequestQueue *queue
);

void queue_lock(RequestQueue *queue);

void queue_unlock(RequestQueue *queue);

void queue_destroy(
    RequestQueue *queue
);


/* =========================
   COMPLETION QUEUE
   ========================= */

void completion_queue_init(
    CompletionQueue *queue
);

void completion_queue_set_hooks(
    CompletionQueue *queue,
    CompletionHook on_enqueue,
    CompletionHook on_dequeue,
    void *ctx
);

void completion_enqueue(
    CompletionQueue *queue,
    Completion completion
);

Completion completion_dequeue(
    CompletionQueue *queue
);

int completion_queue_size(
    CompletionQueue *queue
);

void completion_queue_lock(CompletionQueue *queue);

void completion_queue_unlock(CompletionQueue *queue);

void completion_queue_destroy(
    CompletionQueue *queue
);

#endif
