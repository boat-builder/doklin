// Doklin's engine, for C and Swift. Declared here as engine/ffi/src/lib.rs
// defines it — change both.
//
// Every string is UTF-8 and NUL-terminated. A string handed to a callback is
// the callback's to read until it returns, and no longer.

#ifndef DOKLIN_ENGINE_H
#define DOKLIN_ENGINE_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// (event name, payload as JSON), from any thread.
typedef void (*doklin_event_callback)(const char *event, const char *payload);

// (context, ok, answer): the command's answer as JSON when `ok`, else a
// sentence saying why not. Called once, from a thread of the engine's.
typedef void (*doklin_done_callback)(void *context, bool ok, const char *answer);

// (workspace id) -> the sign-in kept for it, allocated with malloc (the
// engine frees it), or NULL when there is none. From any thread.
typedef char *(*doklin_secret_get_callback)(const char *ws_id);

// (workspace id, token): keep `token` for the workspace, or forget what is
// kept when it is NULL. Answers true once done. From any thread.
typedef bool (*doklin_secret_set_callback)(const char *ws_id, const char *token);

// Start the engine. `config` is JSON: dataDir, joinDir, anchor (optional),
// client, deviceName. Sign-ins are kept through get_secret and set_secret,
// never in the engine's files. Answers NULL, or a sentence saying why it did
// not start, to hand back to doklin_engine_free. A second call changes nothing.
char *doklin_engine_start(const char *config, doklin_event_callback on_event,
                          doklin_secret_get_callback get_secret, doklin_secret_set_callback set_secret);

// Run the command called `name` with `args` (a JSON object).
void doklin_engine_call(const char *name, const char *args, void *context, doklin_done_callback done);

// Free a string doklin_engine_start answered with. NULL is fine.
void doklin_engine_free(char *text);

#ifdef __cplusplus
}
#endif

#endif
