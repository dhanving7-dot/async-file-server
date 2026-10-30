#include <stdio.h>
#include <time.h>

#include "performance.h"


void performance_start(
    PerformanceRecord *record,
    int request_id,
    int operation
)
{
    record->request_id =
        request_id;

    record->operation =
        operation;

    record->bytes_processed =
        0;

    record->success =
        0;

    record->elapsed_nanoseconds =
        0;


    clock_gettime(
        CLOCK_MONOTONIC,
        &record->start_time
    );
}


void performance_end(
    PerformanceRecord *record,
    int bytes_processed,
    int success
)
{
    clock_gettime(
        CLOCK_MONOTONIC,
        &record->end_time
    );


    record->bytes_processed =
        bytes_processed;

    record->success =
        success;


    record->elapsed_nanoseconds =
        (record->end_time.tv_sec -
         record->start_time.tv_sec)
        * 1000000000L
        +
        (record->end_time.tv_nsec -
         record->start_time.tv_nsec);
}


const char *performance_operation_name(
    int operation
)
{
    if (operation == 1)
    {
        return "READ";
    }
    else if (operation == 2)
    {
        return "WRITE";
    }
    else if (operation == 3)
    {
        return "CREATE";
    }

    return "UNKNOWN";
}


void performance_print(
    PerformanceRecord *record
)
{
    double milliseconds =
        record->elapsed_nanoseconds
        / 1000000.0;


    printf(
        "[PERFORMANCE] "
        "Request %d | "
        "Operation: %s | "
        "Bytes: %d | "
        "Time: %.3f ms | "
        "Status: %s\n",

        record->request_id,

        performance_operation_name(
            record->operation
        ),

        record->bytes_processed,

        milliseconds,

        record->success
            ? "SUCCESS"
            : "FAILED"
    );
}


void performance_stats_init(
    PerformanceStats *stats
)
{
    stats->total_requests = 0;
    stats->successful_requests = 0;
    stats->failed_requests = 0;
    stats->total_bytes = 0;
    stats->total_time_nanoseconds = 0;
    stats->min_time_nanoseconds = 0;
    stats->max_time_nanoseconds = 0;
}


void performance_stats_update(
    PerformanceStats *stats,
    PerformanceRecord *record
)
{
    stats->total_requests++;

    if (record->success)
    {
        stats->successful_requests++;
    }
    else
    {
        stats->failed_requests++;
    }

    stats->total_bytes +=
        record->bytes_processed;

    stats->total_time_nanoseconds +=
        record->elapsed_nanoseconds;

    if (stats->total_requests == 1 ||
        record->elapsed_nanoseconds < stats->min_time_nanoseconds)
    {
        stats->min_time_nanoseconds =
            record->elapsed_nanoseconds;
    }

    if (record->elapsed_nanoseconds > stats->max_time_nanoseconds)
    {
        stats->max_time_nanoseconds =
            record->elapsed_nanoseconds;
    }
}


void performance_stats_print(
    PerformanceStats *stats
)
{
    double average_ms = 0.0;

    if (stats->total_requests > 0)
    {
        average_ms =
            (stats->total_time_nanoseconds /
             1000000.0)
            /
            stats->total_requests;
    }

    printf("\n");
    printf("========================================\n");
    printf("       PERFORMANCE SUMMARY\n");
    printf("========================================\n");

    printf(
        "Total Requests      : %d\n",
        stats->total_requests
    );

    printf(
        "Successful Requests : %d\n",
        stats->successful_requests
    );

    printf(
        "Failed Requests     : %d\n",
        stats->failed_requests
    );

    printf(
        "Total Bytes         : %ld\n",
        stats->total_bytes
    );

    printf(
        "Average Time        : %.3f ms\n",
        average_ms
    );

    printf("========================================\n");
}
