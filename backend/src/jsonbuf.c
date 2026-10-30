#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "jsonbuf.h"


void jb_init(JsonBuf *jb)
{
    jb->data = NULL;
    jb->len = 0;
    jb->cap = 0;
    jb->failed = 0;
}


void jb_free(JsonBuf *jb)
{
    free(jb->data);
    jb_init(jb);
}


void jb_reset(JsonBuf *jb)
{
    jb->len = 0;
    jb->failed = 0;

    if (jb->data != NULL)
        jb->data[0] = 0;
}


static int jb_reserve(JsonBuf *jb, size_t extra)
{
    if (jb->failed)
        return -1;

    if (jb->len + extra + 1 <= jb->cap)
        return 0;

    size_t cap = jb->cap ? jb->cap : 1024;

    while (cap < jb->len + extra + 1)
        cap *= 2;

    char *data = realloc(jb->data, cap);

    if (data == NULL)
    {
        jb->failed = 1;
        return -1;
    }

    jb->data = data;
    jb->cap = cap;
    return 0;
}


void jb_append(JsonBuf *jb, const char *text)
{
    size_t n = strlen(text);

    if (jb_reserve(jb, n) < 0)
        return;

    memcpy(jb->data + jb->len, text, n);
    jb->len += n;
    jb->data[jb->len] = '\0';
}


void jb_appendf(JsonBuf *jb, const char *fmt, ...)
{
    va_list args;

    va_start(args, fmt);
    int needed = vsnprintf(NULL, 0, fmt, args);
    va_end(args);

    if (needed < 0 || jb_reserve(jb, (size_t)needed) < 0)
        return;

    va_start(args, fmt);
    vsnprintf(jb->data + jb->len, (size_t)needed + 1, fmt, args);
    va_end(args);

    jb->len += (size_t)needed;
}


/*
 * Length of the escaped form of one input byte.
 */
static size_t escaped_len(unsigned char c)
{
    if (c == '"' || c == '\\' || c == '\n' ||
        c == '\r' || c == '\t' || c == '\b' || c == '\f')
        return 2;

    if (c < 0x20 || c == 0x7f)
        return 6;

    return 1;
}


static size_t write_escaped(char *out, unsigned char c)
{
    switch (c)
    {
        case '"':  out[0] = '\\'; out[1] = '"';  return 2;
        case '\\': out[0] = '\\'; out[1] = '\\'; return 2;
        case '\n': out[0] = '\\'; out[1] = 'n';  return 2;
        case '\r': out[0] = '\\'; out[1] = 'r';  return 2;
        case '\t': out[0] = '\\'; out[1] = 't';  return 2;
        case '\b': out[0] = '\\'; out[1] = 'b';  return 2;
        case '\f': out[0] = '\\'; out[1] = 'f';  return 2;
    }

    if (c < 0x20 || c == 0x7f)
    {
        snprintf(out, 7, "\\u%04x", c);
        return 6;
    }

    out[0] = (char)c;
    return 1;
}


/*
 * Shortens len so that text[0..len) does not end in the middle of a
 * UTF-8 multi-byte sequence.
 */
static size_t utf8_safe_length(const char *text, size_t len, size_t full_len)
{
    if (len >= full_len)
        return full_len;

    while (len > 0 && (((unsigned char)text[len]) & 0xC0) == 0x80)
        len--;

    return len;
}


void jb_append_string(JsonBuf *jb, const char *text, size_t max_bytes)
{
    if (text == NULL)
    {
        jb_append(jb, "null");
        return;
    }

    size_t full = strlen(text);
    size_t n = utf8_safe_length(text, max_bytes < full ? max_bytes : full, full);

    size_t needed = 2;

    for (size_t i = 0; i < n; i++)
        needed += escaped_len((unsigned char)text[i]);

    if (jb_reserve(jb, needed) < 0)
        return;

    char *out = jb->data + jb->len;

    *out++ = '"';

    for (size_t i = 0; i < n; i++)
        out += write_escaped(out, (unsigned char)text[i]);

    *out++ = '"';

    jb->len += needed;
    jb->data[jb->len] = '\0';
}


size_t json_escape_into(
    char *out,
    size_t out_size,
    const char *text,
    size_t text_len
)
{
    if (out_size < 3)
    {
        if (out_size > 0)
            out[0] = '\0';
        return 0;
    }

    size_t pos = 0;
    out[pos++] = '"';

    size_t i = 0;

    while (i < text_len)
    {
        unsigned char c = (unsigned char)text[i];

        /* Keep whole UTF-8 sequences together. */
        size_t seq = 1;

        if (c >= 0xF0) seq = 4;
        else if (c >= 0xE0) seq = 3;
        else if (c >= 0xC0) seq = 2;

        if (seq > 1)
        {
            if (i + seq > text_len || pos + seq + 2 > out_size)
                break;

            memcpy(out + pos, text + i, seq);
            pos += seq;
            i += seq;
            continue;
        }

        size_t need = escaped_len(c);

        /* Reserve room for the closing quote and NUL. */
        if (pos + need + 2 > out_size)
            break;

        pos += write_escaped(out + pos, c);
        i++;
    }

    out[pos++] = '"';
    out[pos] = '\0';

    return pos;
}
