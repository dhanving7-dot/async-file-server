#ifndef LOGGER_H
#define LOGGER_H

void init_logger();

void log_message(
    const char *message
);

void close_logger();

#endif
