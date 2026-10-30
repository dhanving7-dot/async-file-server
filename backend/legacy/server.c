#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <pthread.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include "performance.h"
#include "queue.h"
#include "logger.h"
#define PORT 8080
#define BUFFER_SIZE 4096

RequestQueue request_queue;
CompletionQueue completion_queue;


/* =========================================
   WORKER: PROCESS FILE REQUEST
   ========================================= */

PerformanceStats performance_stats;
void process_request(FileRequest request)
{
    Completion completion;
PerformanceRecord performance;

performance_start(
    &performance,
    request.request_id,
    request.operation
);
    memset(&completion, 0, sizeof(completion));

    completion.request_id = request.request_id;
    completion.client_fd = request.client_fd;
    completion.success = 0;


    char filepath[512];

    snprintf(
        filepath,
        sizeof(filepath),
        "files/%s",
        request.filename
    );


    printf("\n[WORKER] Processing Request %d\n",
           request.request_id
);

	char worker_log[256];

    snprintf(
      worker_log,
    sizeof(worker_log),
    "WORKER PROCESSING REQUEST %d",
    request.request_id
);

log_message(worker_log);

    printf(
	"[WORKER] File: %s\n",
           request.filename
);


    /* =====================================
       READ
       ===================================== */

    if (request.operation == OP_READ)
    {
        int file_fd = open(
            filepath,
            O_RDONLY
        );


        if (file_fd < 0)
        {
            snprintf(
                completion.response,
                sizeof(completion.response),
                "ERROR: File not found."
            );

            perror("[WORKER] open");
		performance_end(
    &performance,
    0,
    0
);
performance_stats_update(
    &performance_stats,
    &performance
);

performance_print(
    &performance
);
            completion_enqueue(
                &completion_queue,
                completion
            );

            return;
        }


        char file_buffer[MAX_RESPONSE];

        int bytes_read = read(
            file_fd,
            file_buffer,
            sizeof(file_buffer) - 1
        );


        if (bytes_read < 0)
        {
            snprintf(
                completion.response,
                sizeof(completion.response),
                "ERROR: Could not read file."
            );
        }
        else
        {
            file_buffer[bytes_read] = '\0';

            snprintf(
                completion.response,
                sizeof(completion.response),
                "%s",
                file_buffer
            );

            completion.success = 1;

            printf(
                "[WORKER] READ completed: %d bytes\n",
                bytes_read
            );
performance_end(
    &performance,
    bytes_read,
    1
);
performance_stats_update(
    &performance_stats,
    &performance
);

performance_print(
    &performance
);
        }


        close(file_fd);


        completion_enqueue(
            &completion_queue,
            completion
        );
    }


    /* =====================================
       WRITE
       ===================================== */

    else if (request.operation == OP_WRITE)
    {
        int file_fd = open(
            filepath,
            O_WRONLY | O_CREAT | O_TRUNC,
            0644
        );


        if (file_fd < 0)
        {
            snprintf(
                completion.response,
                sizeof(completion.response),
                "ERROR: Could not open file."
            );

            completion_enqueue(
                &completion_queue,
                completion
            );

            return;
        }


        int bytes_written = write(
            file_fd,
            request.data,
            strlen(request.data)
        );


        if (bytes_written < 0)
        {
            snprintf(
                completion.response,
                sizeof(completion.response),
                "ERROR: Could not write file."
            );
        }
        else
        {
            snprintf(
                completion.response,
                sizeof(completion.response),
                "SUCCESS: File written successfully."
            );

            completion.success = 1;

            printf(
                "[WORKER] WRITE completed: %d bytes\n",
                bytes_written
            );
performance_end(
    &performance,
    bytes_written,
    1
);
performance_stats_update(
    &performance_stats,
    &performance
);

performance_print(
    &performance
);
        }


        close(file_fd);


        completion_enqueue(
            &completion_queue,
            completion
       );
    }


    /* =====================================
       UNKNOWN OPERATION
       ===================================== */

    else
    {
        snprintf(
            completion.response,
            sizeof(completion.response),
            "ERROR: Unknown operation."
        );


        completion_enqueue(
            &completion_queue,
            completion
        );
    }
}


/* =========================================
   WORKER THREAD
   ========================================= */

void *worker_function(void *arg)
{
    printf(
        "[WORKER] Worker thread started.\n"
    );


    while (1)
    {
        FileRequest request =
            dequeue(&request_queue);


        process_request(request);
    }


    return NULL;
}


/* =========================================
   COMPLETION THREAD
   ========================================= */

void *completion_function(void *arg)
{
char completion_log[256];
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

	char completion_log[256];

snprintf(
    completion_log,
    sizeof(completion_log),
    "COMPLETION PROCESSING REQUEST %d",
    completion.request_id
);

log_message(completion_log);
        /*
         * Send final result to client
         */

        send(
            completion.client_fd,
            completion.response,
            strlen(completion.response),
            0
        );


        close(
            completion.client_fd
        );


        printf(
            "[COMPLETION] Request %d delivered to client.\n",
            completion.request_id
        );
	  
	snprintf(
    completion_log,
    sizeof(completion_log),
    "REQUEST %d DELIVERED TO CLIENT",
    completion.request_id
);

log_message(completion_log);

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
   MAIN SERVER
   ========================================= */

int main()
{
    int server_fd;
    int client_fd;

    struct sockaddr_in server_addr;
    struct sockaddr_in client_addr;

    socklen_t client_len;

    char buffer[BUFFER_SIZE];

    int request_counter = 1;

    /* =====================================
   INITIALIZE LOGGER
   ===================================== */

init_logger();
performance_stats_init(
    &performance_stats
);
log_message(
    "ASYNC FILE SERVER STARTED"
);
    /* =====================================
       INITIALIZE QUEUES
       ===================================== */

    queue_init(
        &request_queue
    );

    completion_queue_init(
        &completion_queue
    );


    /* =====================================
       CREATE WORKER THREAD
       ===================================== */

    pthread_t worker_thread;

    if (pthread_create(
        &worker_thread,
        NULL,
        worker_function,
        NULL
    ) != 0)
    {
        perror("pthread_create");
        exit(EXIT_FAILURE);
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

    server_fd = socket(
        AF_INET,
        SOCK_STREAM,
        0
    );


    if (server_fd < 0)
    {
        perror("socket");
        exit(EXIT_FAILURE);
    }


    /* =====================================
       REUSE PORT
       ===================================== */

    int opt = 1;

    setsockopt(
        server_fd,
        SOL_SOCKET,
        SO_REUSEADDR,
        &opt,
        sizeof(opt)
    );


    /* =====================================
       SERVER ADDRESS
       ===================================== */

    memset(
        &server_addr,
        0,
        sizeof(server_addr)
    );


    server_addr.sin_family =
        AF_INET;

    server_addr.sin_addr.s_addr =
        INADDR_ANY;

    server_addr.sin_port =
        htons(PORT);


    /* =====================================
       BIND
       ===================================== */

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


    /* =====================================
       LISTEN
       ===================================== */

    if (listen(
        server_fd,
        10
    ) < 0)
    {
        perror("listen");
        close(server_fd);
        exit(EXIT_FAILURE);
    }


    printf("\n");
    printf("====================================\n");
    printf("     ASYNC FILE SERVER - FULL        \n");
    printf("====================================\n");
    printf("Server listening on port %d\n",
           PORT);
    printf("Worker thread active.\n");
    printf("Completion thread active.\n");
    printf("Waiting for clients...\n\n");


    /* =====================================
       ACCEPT CLIENTS
       ===================================== */

    while (1)
    {
        client_len =
            sizeof(client_addr);


        client_fd = accept(
            server_fd,
            (struct sockaddr *)&client_addr,
            &client_len
        );


        if (client_fd < 0)
        {
            perror("accept");
            continue;
        }


        printf(
            "[SERVER] Client connected.\n"
        );
	log_message(
    "CLIENT CONNECTED"
);

        /* =================================
           RECEIVE REQUEST
           ================================= */

        memset(
            buffer,
            0,
            sizeof(buffer)
        );


        int bytes_received = recv(
            client_fd,
            buffer,
            sizeof(buffer) - 1,
            0
        );


        if (bytes_received <= 0)
        {
            close(client_fd);
            continue;
        }


        buffer[bytes_received] =
            '\0';


        printf(
            "[SERVER] Request received: %s\n",
            buffer
        );
		char request_log[BUFFER_SIZE + 32];

snprintf(
    request_log,
    sizeof(request_log),
    "REQUEST RECEIVED: %s",
    buffer
);

log_message(request_log);

        /* =================================
           CREATE REQUEST
           ================================= */

        FileRequest request;

        memset(
            &request,
            0,
            sizeof(request)
        );


        request.request_id =
            request_counter++;


        request.client_fd =
            client_fd;


        /* =================================
           READ REQUEST
           ================================= */

        if (strncmp(
            buffer,
            "READ ",
            5
        ) == 0)
        {
            request.operation =
                OP_READ;


            sscanf(
                buffer + 5,
                "%255s",
                request.filename
            );
        }


        /* =================================
           WRITE REQUEST
           ================================= */

        else if (strncmp(
            buffer,
            "WRITE ",
            6
        ) == 0)
        {
            request.operation =
                OP_WRITE;


            char *content =
                buffer + 6;


            char *space =
                strchr(
                    content,
                    ' '
                );


            if (space == NULL)
            {
                const char *error =
                    "ERROR: Invalid WRITE request.";


                send(
                    client_fd,
                    error,
                    strlen(error),
                    0
                );


                close(client_fd);

                continue;
            }


            *space = '\0';


            strncpy(
                request.filename,
                content,
                MAX_FILENAME - 1
            );


            strncpy(
                request.data,
                space + 1,
                MAX_DATA - 1
            );
        }


        /* =================================
           UNKNOWN REQUEST
           ================================= */

        else
        {
            const char *error =
                "ERROR: Unknown request.";


            send(
                client_fd,
                error,
                strlen(error),
                0
            );


            close(client_fd);

            continue;
        }


        /* =================================
           ADD TO REQUEST QUEUE
           ================================= */

        enqueue(
            &request_queue,
            request
        );


        printf(
            "[SERVER] Request %d added to queue.\n",
            request.request_id
        );

	char queue_log[256];

snprintf(
    queue_log,
    sizeof(queue_log),
    "REQUEST %d ADDED TO QUEUE",
    request.request_id
);

log_message(queue_log);

        printf(
            "[SERVER] Request queue size: %d\n",
            queue_size(
                &request_queue
            )
        );


        /*
         * DO NOT close client_fd here.
         *
         * Completion thread will close it
         * after sending the response.
         */
    }


    close(server_fd);

    queue_destroy(
        &request_queue
    );

    completion_queue_destroy(
        &completion_queue
    );

    return 0;
}
