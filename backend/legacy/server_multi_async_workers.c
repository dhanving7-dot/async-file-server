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
#define NUM_WORKERS 4

RequestQueue request_queue;
CompletionQueue completion_queue;



/* =========================================
   SEND ALL BYTES
   ========================================= */

int send_all(int fd, const char *data, size_t length)
{
    size_t sent = 0;

    while (sent < length)
    {
        ssize_t n = send(fd, data + sent, length - sent, 0);

        if (n <= 0)
            return -1;

        sent += (size_t)n;
    }

    return 0;
}


/* =========================================
   SEND FRAMED RESPONSE
   Protocol:
   RESP <request_id> <payload_length>\n
   <payload bytes>
   ========================================= */

int send_framed_response(int fd, int request_id, const char *response)
{
    char header[128];

    size_t payload_length = strlen(response);

    int header_length = snprintf(
        header,
        sizeof(header),
        "RESP %d %zu\n",
        request_id,
        payload_length
    );

    if (header_length <= 0 ||
        send_all(fd, header, (size_t)header_length) < 0)
    {
        return -1;
    }

    if (payload_length > 0 &&
        send_all(fd, response, payload_length) < 0)
    {
        return -1;
    }

    return 0;
}


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

        if (send_framed_response(
                completion.client_fd,
                completion.request_id,
                completion.response
            ) < 0)
        {
            printf(
                "[COMPLETION] Failed to send Request %d response.\n",
                completion.request_id
            );
        }


        /*
         * Keep the client connection open.
         * The same client may send more requests.
         */


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
       CREATE MULTIPLE WORKER THREADS
       ===================================== */

    pthread_t worker_threads[NUM_WORKERS];

    for (int i = 0; i < NUM_WORKERS; i++)
    {
        if (pthread_create(
            &worker_threads[i],
            NULL,
            worker_function,
            NULL
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
    printf("%d worker threads active.\n", NUM_WORKERS);
    printf("Completion thread active.\n");
    printf("Waiting for clients...\n\n");


    /* =====================================
       ACCEPT CLIENTS
       ===================================== */

    while (1)
    {
        client_len = sizeof(client_addr);

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

        printf("[SERVER] Client connected.\n");
        log_message("CLIENT CONNECTED");

        /*
         * TCP is a byte stream, so one recv() may contain
         * several requests or only part of a request.
         *
         * Each client request is therefore terminated by '\n'.
         * This allows the same client to send many requests
         * in one batch without waiting for responses.
         */
        char pending[BUFFER_SIZE * 4];
        size_t pending_len = 0;

        while (1)
        {
            /*
             * Make room in the pending buffer.
             */
            if (pending_len == sizeof(pending))
            {
                const char *error =
                    "ERROR: Request batch too large.";

                send_framed_response(
                    client_fd,
                    0,
                    error
                );

                pending_len = 0;
            }

            int bytes_received = recv(
                client_fd,
                pending + pending_len,
                sizeof(pending) - pending_len,
                0
            );

            if (bytes_received <= 0)
            {
                printf("[SERVER] Client disconnected.\n");
                log_message("CLIENT DISCONNECTED");
                close(client_fd);
                break;
            }

            pending_len += (size_t)bytes_received;

            /*
             * Process every complete request currently
             * present in the TCP receive buffer.
             */
            while (1)
            {
                char *newline = memchr(
                    pending,
                    '\n',
                    pending_len
                );

                if (newline == NULL)
                    break;

                size_t line_len =
                    (size_t)(newline - pending);

                /*
                 * Remove optional '\r' for CRLF clients.
                 */
                if (line_len > 0 &&
                    pending[line_len - 1] == '\r')
                {
                    line_len--;
                }

                char request_buffer[BUFFER_SIZE];

                if (line_len >= sizeof(request_buffer))
                {
                    const char *error =
                        "ERROR: Request is too long.";

                    send_framed_response(
                        client_fd,
                        0,
                        error
                    );

                    /*
                     * Remove this complete oversized line.
                     */
                    size_t consumed =
                        (size_t)(newline - pending) + 1;

                    memmove(
                        pending,
                        pending + consumed,
                        pending_len - consumed
                    );

                    pending_len -= consumed;
                    continue;
                }

                memcpy(
                    request_buffer,
                    pending,
                    line_len
                );

                request_buffer[line_len] = '\0';

                /*
                 * Remove the processed line from the
                 * receive buffer.
                 */
                size_t consumed =
                    (size_t)(newline - pending) + 1;

                memmove(
                    pending,
                    pending + consumed,
                    pending_len - consumed
                );

                pending_len -= consumed;

                if (line_len == 0)
                    continue;

                printf(
                    "[SERVER] Request received: %s\n",
                    request_buffer
                );

                char request_log[BUFFER_SIZE + 64];

                snprintf(
                    request_log,
                    sizeof(request_log),
                    "REQUEST RECEIVED: %s",
                    request_buffer
                );

                log_message(request_log);

                /* =================================
                   EXIT REQUEST
                   ================================= */

                if (strcmp(request_buffer, "EXIT") == 0)
                {
                    const char *goodbye =
                        "Connection closed. Goodbye!";

                    send_framed_response(
                        client_fd,
                        0,
                        goodbye
                    );

                    printf(
                        "[SERVER] Client requested exit.\n"
                    );

                    log_message(
                        "CLIENT REQUESTED EXIT"
                    );

                    close(client_fd);
                    goto next_client;
                }

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
                        request_buffer,
                        "READ ",
                        5
                    ) == 0)
                {
                    request.operation =
                        OP_READ;

                    sscanf(
                        request_buffer + 5,
                        "%255s",
                        request.filename
                    );

                    if (request.filename[0] == '\0')
                    {
                        const char *error =
                            "ERROR: Filename is required.";

                        send_framed_response(
                            client_fd,
                            request.request_id,
                            error
                        );

                        continue;
                    }
                }

                /* =================================
                   WRITE REQUEST
                   ================================= */

                else if (strncmp(
                            request_buffer,
                            "WRITE ",
                            6
                        ) == 0)
                {
                    request.operation =
                        OP_WRITE;

                    char *content =
                        request_buffer + 6;

                    char *space =
                        strchr(content, ' ');

                    if (space == NULL)
                    {
                        const char *error =
                            "ERROR: Invalid WRITE request.";

                        send_framed_response(
                            client_fd,
                            request.request_id,
                            error
                        );

                        continue;
                    }

                    *space = '\0';

                    strncpy(
                        request.filename,
                        content,
                        MAX_FILENAME - 1
                    );

                    request.filename[
                        MAX_FILENAME - 1
                    ] = '\0';

                    strncpy(
                        request.data,
                        space + 1,
                        MAX_DATA - 1
                    );

                    request.data[
                        MAX_DATA - 1
                    ] = '\0';
                }

                /* =================================
                   UNKNOWN REQUEST
                   ================================= */

                else
                {
                    const char *error =
                        "ERROR: Unknown request.";

                    send_framed_response(
                        client_fd,
                        request.request_id,
                        error
                    );

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
                    queue_size(&request_queue)
                );

                /*
                 * IMPORTANT:
                 * Do not wait for the response here.
                 * The completion thread sends it later.
                 *
                 * Therefore multiple requests from the
                 * same client can be placed into the queue
                 * before their responses are received.
                 */
            }
        }

next_client:
        ;
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
