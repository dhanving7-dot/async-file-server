#ifndef JSONBUF_H
#define JSONBUF_H

#include <stddef.h>

/*
 * Minimal growable string buffer used to build JSON payloads for the
 * monitoring commands (STATS, LIST, LOGS) and live events.
 */

typedef struct
{
    char *data;
    size_t len;
    size_t cap;
    int failed;     /* set if an allocation failed */

} JsonBuf;

void jb_init(JsonBuf *jb);

void jb_free(JsonBuf *jb);

/* Empties the buffer but keeps its allocation. */
void jb_reset(JsonBuf *jb);

void jb_append(JsonBuf *jb, const char *text);

void jb_appendf(JsonBuf *jb, const char *fmt, ...)
    __attribute__((format(printf, 2, 3)));

/* Appends a quoted, escaped JSON string of at most max_bytes input bytes. */
void jb_append_string(JsonBuf *jb, const char *text, size_t max_bytes);

/*
 * Escapes text into a fixed buffer as a quoted JSON string.
 * Never splits a UTF-8 sequence; always NUL terminates.
 * Returns the number of characters written (excluding NUL).
 */
size_t json_escape_into(
    char *out,
    size_t out_size,
    const char *text,
    size_t text_len
);

#endif
