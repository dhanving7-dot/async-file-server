#include <stdio.h>
#include <time.h>
#include <pthread.h>

#include "logger.h"

static FILE *log_file = NULL;

static pthread_mutex_t log_mutex =
    PTHREAD_MUTEX_INITIALIZER;


void init_logger()
{
    log_file = fopen(
        "logs/server.log",
        "a"
    );

    if (log_file == NULL)
    {
        perror("Could not open log file");
    }
}


void log_message(
    const char *message
)
{
    if (log_file == NULL)
    {
        return;
    }


    time_t now =
        time(NULL);

    struct tm *time_info =
        localtime(&now);


    pthread_mutex_lock(
        &log_mutex
    );


    fprintf(
        log_file,
        "[%04d-%02d-%02d %02d:%02d:%02d] %s\n",

        time_info->tm_year + 1900,
        time_info->tm_mon + 1,
        time_info->tm_mday,

        time_info->tm_hour,
        time_info->tm_min,
        time_info->tm_sec,

        message
    );


    fflush(log_file);


    pthread_mutex_unlock(
        &log_mutex
    );
}


void close_logger()
{
    if (log_file != NULL)
    {
        fclose(log_file);

        log_file = NULL;
    }


    pthread_mutex_destroy(
        &log_mutex
    );
}
