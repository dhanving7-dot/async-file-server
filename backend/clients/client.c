#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>

#define PORT 8080
#define BUFFER_SIZE 102400
#define MAX_BATCH_REQUESTS 20

/* =========================================
   SEND ALL BYTES
   ========================================= */

int send_all(int fd, const char *data, size_t length)
{
    size_t sent = 0;

    while (sent < length)
    {
        ssize_t n = send(
            fd,
            data + sent,
            length - sent,
            0
        );

        if (n <= 0)
            return -1;

        sent += (size_t)n;
    }

    return 0;
}


/* =========================================
   RECEIVE EXACT NUMBER OF BYTES
   ========================================= */

int recv_all(int fd, char *buffer, size_t length)
{
    size_t received = 0;

    while (received < length)
    {
        ssize_t n = recv(
            fd,
            buffer + received,
            length - received,
            0
        );

        if (n <= 0)
            return -1;

        received += (size_t)n;
    }

    return 0;
}


/* =========================================
   RECEIVE ONE FRAMED RESPONSE

   Protocol:
   RESP <request_id> <payload_length>\n
   <payload bytes>
   ========================================= */

int receive_response(
    int sock,
    int *request_id,
    char *response,
    size_t response_size
)
{
    char header[128];
    size_t header_len = 0;

    /*
     * Read the header one byte at a time.
     * This is fine for this small college project
     * and makes the TCP framing easy to understand.
     */
    while (header_len < sizeof(header) - 1)
    {
        char ch;

        ssize_t n = recv(
            sock,
            &ch,
            1,
            0
        );

        if (n <= 0)
            return -1;

        header[header_len++] = ch;

        if (ch == '\n')
            break;
    }

    header[header_len] = '\0';

    if (header_len == 0 ||
        header[header_len - 1] != '\n')
    {
        return -1;
    }

    size_t payload_length = 0;

    if (sscanf(
            header,
            "RESP %d %zu",
            request_id,
            &payload_length
        ) != 2)
    {
        printf(
            "[CLIENT] Invalid response header: %s",
            header
        );

        return -1;
    }

    /*
     * The response buffer must always have room
     * for the terminating '\0'.
     */
    if (payload_length >= response_size)
    {
        printf(
            "[CLIENT] Response is too large (%zu bytes).\n",
            payload_length
        );

        /*
         * We still need to consume the payload so
         * that the TCP connection remains synchronized.
         */
        char discard[512];
        size_t remaining = payload_length;

        while (remaining > 0)
        {
            size_t chunk =
                remaining < sizeof(discard)
                    ? remaining
                    : sizeof(discard);

            if (recv_all(
                    sock,
                    discard,
                    chunk
                ) < 0)
            {
                return -1;
            }

            remaining -= chunk;
        }

        return -2;
    }

    if (recv_all(
            sock,
            response,
            payload_length
        ) < 0)
    {
        return -1;
    }

    response[payload_length] = '\0';

    return 0;
}


/* =========================================
   BUILD A SINGLE REQUEST
   ========================================= */

int build_request(
    char *request,
    size_t request_size
)
{
    int type;

    printf("\n");
    printf("1. READ file\n");
    printf("2. WRITE file\n");
    printf("Enter request type: ");

    if (scanf("%d", &type) != 1)
    {
        while (getchar() != '\n')
            ;

        printf("Invalid request type.\n");
        return 0;
    }

    getchar();

    if (type == 1)
    {
        char filename[256];

        printf("Enter filename to READ: ");

        if (fgets(
                filename,
                sizeof(filename),
                stdin
            ) == NULL)
        {
            return 0;
        }

        filename[strcspn(
            filename,
            "\n"
        )] = '\0';

        if (filename[0] == '\0')
        {
            printf("Filename cannot be empty.\n");
            return 0;
        }

        /*
         * '\n' is the request delimiter.
         */
        snprintf(
            request,
            request_size,
            "READ %s\n",
            filename
        );

        return 1;
    }

    if (type == 2)
    {
        char filename[256];
        char data[3500];

        printf("Enter filename to WRITE: ");

        if (fgets(
                filename,
                sizeof(filename),
                stdin
            ) == NULL)
        {
            return 0;
        }

        filename[strcspn(
            filename,
            "\n"
        )] = '\0';

        if (filename[0] == '\0')
        {
            printf("Filename cannot be empty.\n");
            return 0;
        }

        printf("Enter data to write: ");

        if (fgets(
                data,
                sizeof(data),
                stdin
            ) == NULL)
        {
            return 0;
        }

        data[strcspn(
            data,
            "\n"
        )] = '\0';

        snprintf(
            request,
            request_size,
            "WRITE %s %s\n",
            filename,
            data
        );

        return 1;
    }

    printf("Invalid request type.\n");
    return 0;
}


/* =========================================
   MAIN
   ========================================= */

int main()
{
    int sock;
    struct sockaddr_in server_addr;

    /* =====================================
       CREATE SOCKET
       ===================================== */

    sock = socket(
        AF_INET,
        SOCK_STREAM,
        0
    );

    if (sock < 0)
    {
        perror("Socket creation failed");
        return 1;
    }

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

    server_addr.sin_port =
        htons(PORT);

    if (inet_pton(
            AF_INET,
            "127.0.0.1",
            &server_addr.sin_addr
        ) <= 0)
    {
        perror("Invalid server address");
        close(sock);
        return 1;
    }

    /* =====================================
       CONNECT
       ===================================== */

    if (connect(
            sock,
            (struct sockaddr *)&server_addr,
            sizeof(server_addr)
        ) < 0)
    {
        perror("Connection failed");
        close(sock);
        return 1;
    }

    printf("\n");
    printf("============================================\n");
    printf("       ASYNC FILE SERVER CLIENT             \n");
    printf("============================================\n");
    printf("Connected to server.\n");

    while (1)
    {
        int choice;

        printf("\n");
        printf("============================================\n");
        printf("1. Send single READ/WRITE request\n");
        printf("2. Send MULTIPLE requests asynchronously\n");
        printf("3. EXIT\n");
        printf("============================================\n");
        printf("Enter choice: ");

        if (scanf("%d", &choice) != 1)
        {
            printf("Invalid choice.\n");

            while (getchar() != '\n')
                ;

            continue;
        }

        getchar();

        /* =================================
           OPTION 1: SINGLE REQUEST
           ================================= */

        if (choice == 1)
        {
            char request[BUFFER_SIZE];

            if (!build_request(
                    request,
                    sizeof(request)
                ))
            {
                continue;
            }

            printf(
                "\n[CLIENT] Sending request...\n"
            );

            if (send_all(
                    sock,
                    request,
                    strlen(request)
                ) < 0)
            {
                perror("send");
                break;
            }

            int request_id;
            char response[BUFFER_SIZE];

            int result = receive_response(
                sock,
                &request_id,
                response,
                sizeof(response)
            );

            if (result < 0)
            {
                printf(
                    "[CLIENT] Failed to receive response.\n"
                );
                break;
            }

            printf(
                "\n[RESPONSE - Request %d]\n%s\n",
                request_id,
                response
            );
        }

        /* =================================
           OPTION 2:
           MULTIPLE OUTSTANDING REQUESTS
           ================================= */

        else if (choice == 2)
        {
            int count;

            printf(
                "\nHow many requests do you want to send at once? "
            );

            if (scanf("%d", &count) != 1)
            {
                while (getchar() != '\n')
                    ;

                printf("Invalid number.\n");
                continue;
            }

            getchar();

            if (count < 1 ||
                count > MAX_BATCH_REQUESTS)
            {
                printf(
                    "Enter a number between 1 and %d.\n",
                    MAX_BATCH_REQUESTS
                );

                continue;
            }

            char requests[
                MAX_BATCH_REQUESTS
            ][BUFFER_SIZE];

            int valid_count = 0;

            /*
             * Build ALL requests first.
             * No response is received during this phase.
             */
            for (int i = 0; i < count; i++)
            {
                printf(
                    "\n========== Request %d/%d ==========\n",
                    i + 1,
                    count
                );

                if (build_request(
                        requests[valid_count],
                        BUFFER_SIZE
                    ))
                {
                    valid_count++;
                }
                else
                {
                    printf(
                        "Request %d was not created.\n",
                        i + 1
                    );
                }
            }

            if (valid_count == 0)
            {
                printf(
                    "No valid requests were created.\n"
                );

                continue;
            }

            printf("\n");
            printf(
                "============================================\n"
            );
            printf(
                " SENDING %d REQUESTS WITHOUT WAITING        \n",
                valid_count
            );
            printf(
                "============================================\n"
            );

            /*
             * IMPORTANT:
             *
             * All requests are sent first.
             * There is NO recv() here.
             *
             * Therefore the server can queue and process
             * several requests from this same TCP client
             * before the client receives any response.
             */
            for (int i = 0; i < valid_count; i++)
            {
                if (send_all(
                        sock,
                        requests[i],
                        strlen(requests[i])
                    ) < 0)
                {
                    perror("send");
                    close(sock);
                    return 1;
                }

                printf(
                    "[CLIENT] Request %d/%d sent.\n",
                    i + 1,
                    valid_count
                );
            }

            printf("\n");
            printf(
                "[CLIENT] All %d requests have been sent.\n",
                valid_count
            );

            printf(
                "[CLIENT] Now waiting for responses...\n"
            );

            /*
             * Receive the responses only AFTER all
             * requests have been submitted.
             */
            for (int i = 0; i < valid_count; i++)
            {
                int request_id;
                char response[BUFFER_SIZE];

                int result = receive_response(
                    sock,
                    &request_id,
                    response,
                    sizeof(response)
                );

                if (result < 0)
                {
                    printf(
                        "[CLIENT] Failed while receiving "
                        "response %d/%d.\n",
                        i + 1,
                        valid_count
                    );

                    close(sock);
                    return 1;
                }

                printf("\n");
                printf(
                    "--------------------------------------------\n"
                );
                printf(
                    " RESPONSE FOR REQUEST ID: %d\n",
                    request_id
                );
                printf(
                    "--------------------------------------------\n"
                );
                printf(
                    "%s\n",
                    response
                );
            }

            printf("\n");
            printf(
                "[CLIENT] Batch completed. "
                "All responses received.\n"
            );
        }

        /* =================================
           OPTION 3: EXIT
           ================================= */

        else if (choice == 3)
        {
            const char *exit_request =
                "EXIT\n";

            if (send_all(
                    sock,
                    exit_request,
                    strlen(exit_request)
                ) < 0)
            {
                perror("send");
                break;
            }

            int request_id;
            char response[BUFFER_SIZE];

            if (receive_response(
                    sock,
                    &request_id,
                    response,
                    sizeof(response)
                ) == 0)
            {
                printf(
                    "\nServer: %s\n",
                    response
                );
            }

            break;
        }

        else
        {
            printf(
                "Invalid choice. Select 1, 2 or 3.\n"
            );
        }
    }

    close(sock);

    printf(
        "\n[CLIENT] Connection closed.\n"
    );

    return 0;
}
