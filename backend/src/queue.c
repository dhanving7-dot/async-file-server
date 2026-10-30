#include <stdio.h>
#include <stdlib.h>

#include "queue.h"


/* =========================================
   REQUEST QUEUE
   ========================================= */

void queue_init(RequestQueue *queue)
{
    queue->front = NULL;
    queue->rear = NULL;
    queue->count = 0;

    queue->on_enqueue = NULL;
    queue->on_dequeue = NULL;
    queue->hook_ctx = NULL;

    pthread_mutex_init(
        &queue->mutex,
        NULL
    );

    pthread_cond_init(
        &queue->condition,
        NULL
    );
}


void queue_set_hooks(
    RequestQueue *queue,
    RequestHook on_enqueue,
    RequestHook on_dequeue,
    void *ctx
)
{
    pthread_mutex_lock(&queue->mutex);

    queue->on_enqueue = on_enqueue;
    queue->on_dequeue = on_dequeue;
    queue->hook_ctx = ctx;

    pthread_mutex_unlock(&queue->mutex);
}


void enqueue(
    RequestQueue *queue,
    FileRequest request
)
{
    RequestNode *node =
        malloc(sizeof(RequestNode));

    if (node == NULL)
    {
        perror("malloc");
        return;
    }

    node->request = request;
    node->next = NULL;


    pthread_mutex_lock(
        &queue->mutex
    );


    if (queue->rear == NULL)
    {
        queue->front = node;
        queue->rear = node;
    }
    else
    {
        queue->rear->next = node;
        queue->rear = node;
    }


    queue->count++;


    if (queue->on_enqueue != NULL)
    {
        queue->on_enqueue(
            queue->hook_ctx,
            &node->request,
            NULL,
            queue->count
        );
    }


    pthread_cond_signal(
        &queue->condition
    );


    pthread_mutex_unlock(
        &queue->mutex
    );
}


FileRequest dequeue_by(
    RequestQueue *queue,
    void *who
)
{
    FileRequest request;


    pthread_mutex_lock(
        &queue->mutex
    );


    while (queue->front == NULL)
    {
        pthread_cond_wait(
            &queue->condition,
            &queue->mutex
        );
    }


    RequestNode *node =
        queue->front;


    queue->front =
        node->next;


    if (queue->front == NULL)
    {
        queue->rear = NULL;
    }


    queue->count--;

    request = node->request;

    free(node);


    if (queue->on_dequeue != NULL)
    {
        queue->on_dequeue(
            queue->hook_ctx,
            &request,
            who,
            queue->count
        );
    }


    pthread_mutex_unlock(
        &queue->mutex
    );


    return request;
}


FileRequest dequeue(
    RequestQueue *queue
)
{
    return dequeue_by(queue, NULL);
}


int queue_size(
    RequestQueue *queue
)
{
    pthread_mutex_lock(
        &queue->mutex
    );

    int size = queue->count;

    pthread_mutex_unlock(
        &queue->mutex
    );

    return size;
}


void queue_lock(RequestQueue *queue)
{
    pthread_mutex_lock(&queue->mutex);
}


void queue_unlock(RequestQueue *queue)
{
    pthread_mutex_unlock(&queue->mutex);
}


void queue_destroy(
    RequestQueue *queue
)
{
    RequestNode *current =
        queue->front;


    while (current != NULL)
    {
        RequestNode *next =
            current->next;

        free(current->request.data);
        free(current);

        current = next;
    }


    pthread_mutex_destroy(
        &queue->mutex
    );

    pthread_cond_destroy(
        &queue->condition
    );
}


/* =========================================
   COMPLETION QUEUE
   ========================================= */

void completion_queue_init(
    CompletionQueue *queue
)
{
    queue->front = NULL;
    queue->rear = NULL;
    queue->count = 0;

    queue->on_enqueue = NULL;
    queue->on_dequeue = NULL;
    queue->hook_ctx = NULL;

    pthread_mutex_init(
        &queue->mutex,
        NULL
    );

    pthread_cond_init(
        &queue->condition,
        NULL
    );
}


void completion_queue_set_hooks(
    CompletionQueue *queue,
    CompletionHook on_enqueue,
    CompletionHook on_dequeue,
    void *ctx
)
{
    pthread_mutex_lock(&queue->mutex);

    queue->on_enqueue = on_enqueue;
    queue->on_dequeue = on_dequeue;
    queue->hook_ctx = ctx;

    pthread_mutex_unlock(&queue->mutex);
}


void completion_enqueue(
    CompletionQueue *queue,
    Completion completion
)
{
    CompletionNode *node =
        malloc(sizeof(CompletionNode));

    if (node == NULL)
    {
        perror("malloc");
        return;
    }

    node->completion = completion;
    node->next = NULL;


    pthread_mutex_lock(
        &queue->mutex
    );


    if (queue->rear == NULL)
    {
        queue->front = node;
        queue->rear = node;
    }
    else
    {
        queue->rear->next = node;
        queue->rear = node;
    }


    queue->count++;


    if (queue->on_enqueue != NULL)
    {
        queue->on_enqueue(
            queue->hook_ctx,
            &node->completion,
            queue->count
        );
    }


    pthread_cond_signal(
        &queue->condition
    );


    pthread_mutex_unlock(
        &queue->mutex
    );
}


Completion completion_dequeue(
    CompletionQueue *queue
)
{
    Completion completion;


    pthread_mutex_lock(
        &queue->mutex
    );


    while (queue->front == NULL)
    {
        pthread_cond_wait(
            &queue->condition,
            &queue->mutex
        );
    }


    CompletionNode *node =
        queue->front;


    queue->front =
        node->next;


    if (queue->front == NULL)
    {
        queue->rear = NULL;
    }


    queue->count--;

    completion =
        node->completion;


    free(node);


    if (queue->on_dequeue != NULL)
    {
        queue->on_dequeue(
            queue->hook_ctx,
            &completion,
            queue->count
        );
    }


    pthread_mutex_unlock(
        &queue->mutex
    );


    return completion;
}


int completion_queue_size(
    CompletionQueue *queue
)
{
    pthread_mutex_lock(
        &queue->mutex
    );

    int size = queue->count;

    pthread_mutex_unlock(
        &queue->mutex
    );

    return size;
}


void completion_queue_lock(CompletionQueue *queue)
{
    pthread_mutex_lock(&queue->mutex);
}


void completion_queue_unlock(CompletionQueue *queue)
{
    pthread_mutex_unlock(&queue->mutex);
}


void completion_queue_destroy(
    CompletionQueue *queue
)
{
    CompletionNode *current =
        queue->front;


    while (current != NULL)
    {
        CompletionNode *next =
            current->next;

        free(current->completion.response);
        free(current);

        current = next;
    }


    pthread_mutex_destroy(
        &queue->mutex
    );

    pthread_cond_destroy(
        &queue->condition
    );
}
