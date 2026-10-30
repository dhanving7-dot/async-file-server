#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include <pthread.h>

#include "logger.h"

#define LOG_RING_SIZE 2000

static FILE *log_file = NULL;

static pthread_mutex_t log_mutex =
    PTHREAD_MUTEX_INITIALIZER;

/* In-memory ring of recent entries, protected by log_mutex. */
static LogEntry log_ring[LOG_RING_SIZE];
static unsigned long long log_seq = 0;

static void (*log_sink)(const LogEntry *entry) = NULL;


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


void logger_set_sink(
    void (*sink)(const LogEntry *entry)
)
{
    pthread_mutex_lock(&log_mutex);
    log_sink = sink;
    pthread_mutex_unlock(&log_mutex);
}


const char *log_level_name(int level)
{
    switch (level)
    {
        case LOG_DEBUG: return "DEBUG";
        case LOG_INFO:  return "INFO";
        case LOG_WARN:  return "WARN";
        case LOG_ERROR: return "ERROR";
    }

    return "INFO";
}


static void log_write(
    int level,
    int request_id,
    const char *message
)
{
    struct timeval tv;

    gettimeofday(&tv, NULL);

    struct tm time_info;

    localtime_r(&tv.tv_sec, &time_info);

    LogEntry entry;
    void (*sink)(const LogEntry *entry);


    pthread_mutex_lock(
        &log_mutex
    );

    entry.seq = ++log_seq;
    entry.timestamp_ms =
        (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
    entry.level = level;
    entry.request_id = request_id;

    snprintf(
        entry.message,
        sizeof(entry.message),
        "%s",
        message
    );

    log_ring[(entry.seq - 1) % LOG_RING_SIZE] = entry;

    if (log_file != NULL)
    {
        fprintf(
            log_file,
            "[%04d-%02d-%02d %02d:%02d:%02d] [%s] %s\n",

            time_info.tm_year + 1900,
            time_info.tm_mon + 1,
            time_info.tm_mday,

            time_info.tm_hour,
            time_info.tm_min,
            time_info.tm_sec,

            log_level_name(level),

            entry.message
        );

        fflush(log_file);
    }

    /*
     * The sink runs under log_mutex so log events are published in
     * sequence order. Lock order is log_mutex -> monitor event lock;
     * the monitor never logs while holding its event lock.
     */
    sink = log_sink;

    if (sink != NULL)
    {
        sink(&entry);
    }

    pthread_mutex_unlock(
        &log_mutex
    );
}


void log_message(
    const char *message
)
{
    log_write(LOG_INFO, 0, message);
}


void log_event(
    int level,
    int request_id,
    const char *fmt,
    ...
)
{
    char message[LOG_MESSAGE_MAX];

    va_list args;

    va_start(args, fmt);
    vsnprintf(message, sizeof(message), fmt, args);
    va_end(args);

    log_write(level, request_id, message);
}


void logger_recent_json(
    JsonBuf *jb,
    int limit
)
{
    if (limit <= 0 || limit > LOG_RING_SIZE)
        limit = LOG_RING_SIZE;

    pthread_mutex_lock(&log_mutex);

    unsigned long long count =
        log_seq < (unsigned long long)limit
            ? log_seq
            : (unsigned long long)limit;

    unsigned long long first = log_seq - count + 1;

    jb_append(jb, "[");

    for (unsigned long long s = first; s <= log_seq && count > 0; s++)
    {
        const LogEntry *e = &log_ring[(s - 1) % LOG_RING_SIZE];

        if (s != first)
            jb_append(jb, ",");

        jb_appendf(
            jb,
            "{\"seq\":%llu,\"ts\":%lld,\"level\":\"%s\",\"request_id\":%d,\"message\":",
            e->seq,
            e->timestamp_ms,
            log_level_name(e->level),
            e->request_id
        );

        jb_append_string(jb, e->message, LOG_MESSAGE_MAX);
        jb_append(jb, "}");
    }

    jb_append(jb, "]");

    pthread_mutex_unlock(&log_mutex);
}


void close_logger()
{
    pthread_mutex_lock(&log_mutex);

    if (log_file != NULL)
    {
        fclose(log_file);

        log_file = NULL;
    }

    pthread_mutex_unlock(&log_mutex);
}
