#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>

#define PORT 8080
#define BUFFER_SIZE 1024000

int main() {

    int sock;
    struct sockaddr_in server_addr;
    char buffer[BUFFER_SIZE];

    sock = socket(AF_INET, SOCK_STREAM, 0);

    if (sock < 0) {
        perror("socket");
        exit(EXIT_FAILURE);
    }

    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(PORT);

    if (inet_pton(AF_INET, "127.0.0.1",
                  &server_addr.sin_addr) <= 0) {
        perror("inet_pton");
        close(sock);
        exit(EXIT_FAILURE);
    }

    if (connect(sock,
                (struct sockaddr *)&server_addr,
                sizeof(server_addr)) < 0) {
        perror("connect");
        close(sock);
        exit(EXIT_FAILURE);
    }

    printf("\n====================================\n");
    printf("       ASYNC FILE CLIENT\n");
    printf("====================================\n");
    printf("1. READ file\n");
    printf("2. WRITE file\n");
    printf("Enter choice: ");

    int choice;
    scanf("%d", &choice);

    getchar();

    if (choice == 1) {

        char filename[256];

        printf("Enter filename: ");
        fgets(filename, sizeof(filename), stdin);

        filename[strcspn(filename, "\n")] = '\0';

        snprintf(
            buffer,
            sizeof(buffer),
            "READ %s",
            filename
        );

    } else if (choice == 2) {

        char filename[256];
        char data[3000];

        printf("Enter filename: ");
        fgets(filename, sizeof(filename), stdin);

        filename[strcspn(filename, "\n")] = '\0';

        printf("Enter data to write: ");
        fgets(data, sizeof(data), stdin);

        data[strcspn(data, "\n")] = '\0';

        snprintf(
            buffer,
            sizeof(buffer),
            "WRITE %s %s",
            filename,
            data
        );

    } else {

        printf("Invalid choice.\n");
        close(sock);
        return 0;
    }

    // Send request
    send(
        sock,
        buffer,
        strlen(buffer),
        0
    );

    printf("\nRequest sent: %s\n", buffer);

    // Receive response
    memset(buffer, 0, sizeof(buffer));

    int bytes_received = recv(
        sock,
        buffer,
        sizeof(buffer) - 1,
        0
    );

    if (bytes_received < 0) {
        perror("recv");
    } else {

        buffer[bytes_received] = '\0';

        printf("\n===== SERVER RESPONSE =====\n");
        printf("%s\n", buffer);
        printf("===========================\n");
    }

    close(sock);

    return 0;
}
