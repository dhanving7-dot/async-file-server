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

    pthread_mutex_init(
        &queue->mutex,
        NULL
    );

    pthread_cond_init(
        &queue->condition,
        NULL
    );
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


    pthread_cond_signal(
        &queue->condition
    );


    pthread_mutex_unlock(
        &queue->mutex
    );
}


FileRequest dequeue(
    RequestQueue *queue
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


    pthread_mutex_unlock(
        &queue->mutex
    );


    return request;
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

    pthread_mutex_init(
        &queue->mutex,
        NULL
    );

    pthread_cond_init(
        &queue->condition,
        NULL
    );
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
