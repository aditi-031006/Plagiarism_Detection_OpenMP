#ifndef DOCUMENT_H
#define DOCUMENT_H

#include <stddef.h>
#include <stdint.h>

#define MAX_SHINGLE_K 8

/* One preprocessed document.
 * OWNERSHIP: the Document owns `path` and `shingles` (both malloc'd).
 * They are released by free_documents(). */
typedef struct {
    char     *path;        /* file path (owned)                                  */
    uint64_t *shingles;    /* SORTED, UNIQUE 64-bit hashes of word k-grams (owned) */
    size_t    n_shingles;  /* number of entries in `shingles`                    */
    size_t    n_tokens;    /* number of words found (before k-gram building)     */
    size_t    n_bytes;     /* number of bytes read from the file                 */
} Document;

/* Separate timings so we can report read time and preprocessing time. */
typedef struct {
    double read_seconds;
    double preprocess_seconds;
} LoadStats;

/* Recursively finds all regular files under `root`, sorts their paths
 * alphabetically (so every run uses the same documents in the same order),
 * keeps the first `max_docs` (0 = all), reads each file (only the first
 * `max_bytes` bytes if max_bytes > 0) and builds its shingle set.
 * Returns 0 on success, -1 on error. On success the caller must call
 * free_documents(*out_docs, *out_n). */
int  load_documents(const char *root, int max_docs, size_t max_bytes, int k,
                    Document **out_docs, int *out_n, LoadStats *stats);

void free_documents(Document *docs, int n);

#endif
