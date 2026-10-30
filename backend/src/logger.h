#ifndef LOGGER_H
#define LOGGER_H

#include "jsonbuf.h"

#define LOG_DEBUG 0
#define LOG_INFO  1
#define LOG_WARN  2
#define LOG_ERROR 3

#define LOG_MESSAGE_MAX 512

typedef struct
{
    unsigned long long seq;
    long long timestamp_ms;     /* wall clock, milliseconds since epoch */
    int level;
    int request_id;             /* 0 when not tied to a request */
    char message[LOG_MESSAGE_MAX];

} LogEntry;

void init_logger();

/* Original API: logs at INFO level without a request id. */
void log_message(
    const char *message
);

void log_event(
    int level,
    int request_id,
    const char *fmt,
    ...
) __attribute__((format(printf, 3, 4)));

/*
 * Optional sink invoked after every log entry (outside the logger lock).
 * Used by the monitor to publish log lines on the live event stream.
 */
void logger_set_sink(
    void (*sink)(const LogEntry *entry)
);

/* Appends a JSON array of the most recent entries (oldest first). */
void logger_recent_json(
    JsonBuf *jb,
    int limit
);

const char *log_level_name(int level);

void close_logger();

#endif
