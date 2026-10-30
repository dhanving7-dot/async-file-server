CC      ?= gcc
CFLAGS  ?= -O2 -g
CFLAGS  += -Wall -Wextra -std=gnu11 -pthread -D_GNU_SOURCE
LDFLAGS += -pthread

SERVER_SRC = src/server.c src/queue.c src/logger.c src/performance.c \
             src/monitor.c src/jsonbuf.c
SERVER_OBJ = $(SERVER_SRC:src/%.c=build/%.o)

.PHONY: all clean run

all: server client

build:
	mkdir -p build

build/%.o: src/%.c src/*.h | build
	$(CC) $(CFLAGS) -c $< -o $@

server: $(SERVER_OBJ)
	$(CC) $(LDFLAGS) -o $@ $^

client: clients/client.c
	$(CC) $(CFLAGS) -o $@ $<

run: server
	./server

clean:
	rm -rf build server client
