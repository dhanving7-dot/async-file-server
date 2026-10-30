#ifndef PERFORMANCE_H
#define PERFORMANCE_H

#include <time.h>

typedef struct
{
    struct timespec start_time;
    struct timespec end_time;

    long elapsed_nanoseconds;

    int request_id;
    int operation;
    int bytes_processed;
    int success;

} PerformanceRecord;


/* Statistics for the complete server */

typedef struct
{
    int total_requests;
    int successful_requests;
    int failed_requests;

    long total_bytes;

    long total_time_nanoseconds;

} PerformanceStats;


/* Individual request timing */

void performance_start(
    PerformanceRecord *record,
    int request_id,
    int operation
);

void performance_end(
    PerformanceRecord *record,
    int bytes_processed,
    int success
);

void performance_print(
    PerformanceRecord *record
);


/* Statistics */

void performance_stats_init(
    PerformanceStats *stats
);

void performance_stats_update(
    PerformanceStats *stats,
    PerformanceRecord *record
);

void performance_stats_print(
    PerformanceStats *stats
);

#endif
