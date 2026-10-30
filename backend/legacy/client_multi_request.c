#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>

#define PORT 8080
#define BUFFER_SIZE 4096

int main()
{
    int sock;
    struct sockaddr_in server_addr;
    char buffer[BUFFER_SIZE];

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

    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(PORT);

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
       CONNECT TO SERVER
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

    printf("\n====================================\n");
    printf("       ASYNC FILE SERVER CLIENT     \n");
    printf("====================================\n");
    printf("Connected to server.\n");

    /*
     * Keep the same TCP connection open.
     * The client can perform multiple
     * READ/WRITE operations.
     */
    while (1)
    {
        int choice;

        printf("\n");
        printf("1. READ file\n");
        printf("2. WRITE file\n");
        printf("3. EXIT\n");
        printf("Enter choice: ");

        if (scanf("%d", &choice) != 1)
        {
            printf("Invalid choice.\n");

            while (getchar() != '\n')
                ;

            continue;
        }

        getchar(); /* consume newline */

        /* =================================
           EXIT
           ================================= */

        if (choice == 3)
        {
            const char *exit_request = "EXIT";

            if (send(
                sock,
                exit_request,
                strlen(exit_request),
                0
            ) < 0)
            {
                perror("Failed to send EXIT request");
                break;
            }

            memset(
                buffer,
                0,
                sizeof(buffer)
            );

            int bytes_received = recv(
                sock,
                buffer,
                sizeof(buffer) - 1,
                0
            );

            if (bytes_received > 0)
            {
                buffer[bytes_received] = '\0';
                printf("\nServer: %s\n", buffer);
            }

            break;
        }

        /* =================================
           READ
           ================================= */

        else if (choice == 1)
        {
            char filename[256];

            printf("Enter filename to READ: ");

            if (fgets(
                filename,
                sizeof(filename),
                stdin
            ) == NULL)
            {
                break;
            }

            filename[strcspn(
                filename,
                "\n"
            )] = '\0';

            if (filename[0] == '\0')
            {
                printf("Filename cannot be empty.\n");
                continue;
            }

            snprintf(
                buffer,
                sizeof(buffer),
                "READ %s",
                filename
            );
        }

        /* =================================
           WRITE
           ================================= */

        else if (choice == 2)
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
                break;
            }

            filename[strcspn(
                filename,
                "\n"
            )] = '\0';

            if (filename[0] == '\0')
            {
                printf("Filename cannot be empty.\n");
                continue;
            }

            printf("Enter data to write: ");

            if (fgets(
                data,
                sizeof(data),
                stdin
            ) == NULL)
            {
                break;
            }

            data[strcspn(
                data,
                "\n"
            )] = '\0';

            snprintf(
                buffer,
                sizeof(buffer),
                "WRITE %s %s",
                filename,
                data
            );
        }

        /* =================================
           INVALID CHOICE
           ================================= */

        else
        {
            printf("Invalid choice. Please enter 1, 2, or 3.\n");
            continue;
        }

        /* =================================
           SEND REQUEST
           ================================= */

        if (send(
            sock,
            buffer,
            strlen(buffer),
            0
        ) < 0)
        {
            perror("Failed to send request");
            break;
        }

        printf(
            "\n[CLIENT] Request sent: %s\n",
            buffer
        );

        /* =================================
           RECEIVE RESPONSE
           ================================= */

        memset(
            buffer,
            0,
            sizeof(buffer)
        );

        int bytes_received = recv(
            sock,
            buffer,
            sizeof(buffer) - 1,
            0
        );

        if (bytes_received <= 0)
        {
            printf("Server disconnected.\n");
            break;
        }

        buffer[bytes_received] = '\0';

        printf(
            "[SERVER RESPONSE]\n%s\n",
            buffer
        );
    }

    close(sock);

    printf("\nClient closed.\n");

    return 0;
}
