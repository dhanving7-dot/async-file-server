#ifndef QUEUE_H
#define QUEUE_H

#include <pthread.h>

#define MAX_FILENAME 256
#define MAX_DATA 3500
#define MAX_RESPONSE 1024000

#define OP_READ  1
#define OP_WRITE 2

typedef struct {

    int request_id;

    int operation;

    int client_fd;

    char filename[MAX_FILENAME];

    char data[MAX_DATA];

} FileRequest;


typedef struct {

    int request_id;

    int client_fd;

    int success;

    char response[MAX_RESPONSE];

} Completion;


typedef struct RequestNode {

    FileRequest request;

    struct RequestNode *next;

} RequestNode;


typedef struct CompletionNode {

    Completion completion;

    struct CompletionNode *next;

} CompletionNode;


typedef struct {

    RequestNode *front;

    RequestNode *rear;

    int count;

    pthread_mutex_t mutex;

    pthread_cond_t condition;

} RequestQueue;


typedef struct {

    CompletionNode *front;

    CompletionNode *rear;

    int count;

    pthread_mutex_t mutex;

    pthread_cond_t condition;

} CompletionQueue;


/* =========================
   REQUEST QUEUE
   ========================= */

void queue_init(RequestQueue *queue);

void enqueue(
    RequestQueue *queue,
    FileRequest request
);

FileRequest dequeue(
    RequestQueue *queue
);

int queue_size(
    RequestQueue *queue
);

void queue_destroy(
    RequestQueue *queue
);


/* =========================
   COMPLETION QUEUE
   ========================= */

void completion_queue_init(
    CompletionQueue *queue
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

void completion_queue_destroy(
    CompletionQueue *queue
);

#endif
