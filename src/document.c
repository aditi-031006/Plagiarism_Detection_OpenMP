#include "document.h"

#include <dirent.h>
#include <omp.h>      /* only for omp_get_wtime() as the timer */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define MAX_PATH_LEN 1024
#define MAX_TOKEN_LEN 255

/* ------------------------------------------------------------------ */
/* 1. Finding files                                                    */
/* ------------------------------------------------------------------ */

typedef struct {
    char  **items;
    size_t  count;
    size_t  cap;
} PathList;

static int pathlist_add(PathList *l, const char *p)
{
    if (l->count == l->cap) {
        size_t new_cap = l->cap ? l->cap * 2 : 256;   /* doubling strategy */
        char **tmp = realloc(l->items, new_cap * sizeof(char *));
        if (!tmp) return -1;
        l->items = tmp;
        l->cap = new_cap;
    }
    char *copy = malloc(strlen(p) + 1);
    if (!copy) return -1;
    strcpy(copy, p);
    l->items[l->count++] = copy;
    return 0;
}

static void pathlist_free(PathList *l)
{
    for (size_t i = 0; i < l->count; i++) free(l->items[i]);
    free(l->items);
    l->items = NULL;
    l->count = l->cap = 0;
}

/* Recursively collect regular files. Names starting with '.' are skipped. */
static int collect_files(const char *dir, PathList *out)
{
    DIR *d = opendir(dir);
    if (!d) {
        fprintf(stderr, "Cannot open directory: %s\n", dir);
        return -1;
    }
    struct dirent *e;
    int rc = 0;
    while ((e = readdir(d)) != NULL) {
        if (e->d_name[0] == '.') continue;           /* ".", "..", hidden */
        char path[MAX_PATH_LEN];
        int len = snprintf(path, sizeof path, "%s/%s", dir, e->d_name);
        if (len < 0 || len >= (int)sizeof path) {
            fprintf(stderr, "Path too long, skipped: %s/%s\n", dir, e->d_name);
            continue;
        }
        struct stat st;
        if (stat(path, &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) {
            if (collect_files(path, out) != 0) { rc = -1; break; }
        } else if (S_ISREG(st.st_mode)) {
            if (pathlist_add(out, path) != 0) { rc = -1; break; }
        }
    }
    closedir(d);
    return rc;
}

static int cmp_paths(const void *a, const void *b)
{
    return strcmp(*(char *const *)a, *(char *const *)b);
}

/* ------------------------------------------------------------------ */
/* 2. Reading a file                                                   */
/* ------------------------------------------------------------------ */

/* Returns a NUL-terminated malloc'd buffer, or NULL on error. */
static char *read_file(const char *path, size_t max_bytes, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long size = ftell(f);
    if (size < 0) { fclose(f); return NULL; }
    rewind(f);

    size_t to_read = (size_t)size;
    if (max_bytes > 0 && to_read > max_bytes) to_read = max_bytes;

    char *buf = malloc(to_read + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t got = fread(buf, 1, to_read, f);
    fclose(f);
    buf[got] = '\0';
    *out_len = got;
    return buf;
}

/* ------------------------------------------------------------------ */
/* 3. Preprocessing: tokenize + hash k-word shingles                   */
/* ------------------------------------------------------------------ */

#define FNV_OFFSET 14695981039346656037ULL
#define FNV_PRIME  1099511628211ULL

static uint64_t fnv1a(const char *s, size_t len)
{
    uint64_t h = FNV_OFFSET;
    for (size_t i = 0; i < len; i++) {
        h ^= (unsigned char)s[i];
        h *= FNV_PRIME;
    }
    return h;
}

/* Final avalanche step so that similar inputs give very different hashes. */
static uint64_t mix64(uint64_t x)
{
    x ^= x >> 30; x *= 0xbf58476d1ce4e5b9ULL;
    x ^= x >> 27; x *= 0x94d049bb133111ebULL;
    x ^= x >> 31;
    return x;
}

static int cmp_u64(const void *a, const void *b)
{
    uint64_t x = *(const uint64_t *)a, y = *(const uint64_t *)b;
    return (x > y) - (x < y);
}

/* Append to a growing array (doubling). Returns 0 on success. */
static int push_u64(uint64_t **arr, size_t *n, size_t *cap, uint64_t v)
{
    if (*n == *cap) {
        size_t new_cap = *cap ? *cap * 2 : 1024;
        uint64_t *tmp = realloc(*arr, new_cap * sizeof(uint64_t));
        if (!tmp) return -1;
        *arr = tmp;
        *cap = new_cap;
    }
    (*arr)[(*n)++] = v;
    return 0;
}

/* Pipeline (same for every document, used by every mode):
 *   - only ASCII letters and digits form words; every other byte
 *     (spaces, punctuation, non-ASCII bytes) is a separator
 *   - letters are lower-cased
 *   - numbers are kept as words
 *   - no stop-word removal (common phrases like "of the" stay part of
 *     the k-gram, which is what makes copied text detectable)
 *   - every window of k consecutive words becomes one 64-bit hash
 *   - hashes are sorted and duplicates removed -> a SET of shingles */
static int build_shingles(const char *text, size_t len, int k,
                          uint64_t **out, size_t *out_n, size_t *out_tokens)
{
    uint64_t *arr = NULL;
    size_t n = 0, cap = 0, n_tokens = 0;

    char tok[MAX_TOKEN_LEN + 1];
    size_t tl = 0;
    uint64_t ring[MAX_SHINGLE_K];   /* hashes of the last k words */
    int pos = 0, filled = 0;        /* pos = next slot to write = oldest word */

    for (size_t p = 0; p <= len; p++) {
        unsigned char c = (p < len) ? (unsigned char)text[p] : 0;  /* 0 flushes last word */
        int is_word_char = 0;
        if (c >= 'A' && c <= 'Z') { c = (unsigned char)(c - 'A' + 'a'); is_word_char = 1; }
        else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) is_word_char = 1;

        if (is_word_char) {
            if (tl < MAX_TOKEN_LEN) tok[tl++] = (char)c;
        } else if (tl > 0) {
            ring[pos] = fnv1a(tok, tl);
            pos = (pos + 1) % k;
            if (filled < k) filled++;
            n_tokens++;
            tl = 0;

            if (filled == k) {
                uint64_t h = FNV_OFFSET;
                for (int t = 0; t < k; t++) {            /* oldest -> newest */
                    h ^= ring[(pos + t) % k];
                    h *= FNV_PRIME;
                }
                if (push_u64(&arr, &n, &cap, mix64(h)) != 0) {
                    free(arr);
                    return -1;
                }
            }
        }
    }

    if (n > 1) {
        qsort(arr, n, sizeof(uint64_t), cmp_u64);
        size_t w = 1;                                   /* remove duplicates */
        for (size_t r = 1; r < n; r++)
            if (arr[r] != arr[w - 1]) arr[w++] = arr[r];
        n = w;
    }
    *out = arr;
    *out_n = n;
    *out_tokens = n_tokens;
    return 0;
}

/* ------------------------------------------------------------------ */
/* 4. Public API                                                       */
/* ------------------------------------------------------------------ */

int load_documents(const char *root, int max_docs, size_t max_bytes, int k,
                   Document **out_docs, int *out_n, LoadStats *stats)
{
    if (k < 1 || k > MAX_SHINGLE_K) {
        fprintf(stderr, "Shingle size k must be between 1 and %d\n", MAX_SHINGLE_K);
        return -1;
    }
    stats->read_seconds = 0.0;
    stats->preprocess_seconds = 0.0;

    PathList paths = {0};
    if (collect_files(root, &paths) != 0) { pathlist_free(&paths); return -1; }
    if (paths.count == 0) {
        fprintf(stderr, "No files found under: %s\n", root);
        pathlist_free(&paths);
        return -1;
    }
    qsort(paths.items, paths.count, sizeof(char *), cmp_paths);

    size_t wanted = paths.count;
    if (max_docs > 0 && (size_t)max_docs < wanted) wanted = (size_t)max_docs;

    Document *docs = calloc(wanted, sizeof(Document));
    if (!docs) { pathlist_free(&paths); return -1; }

    int n = 0;
    for (size_t idx = 0; idx < wanted; idx++) {
        double t0 = omp_get_wtime();
        size_t len = 0;
        char *text = read_file(paths.items[idx], max_bytes, &len);
        double t1 = omp_get_wtime();
        stats->read_seconds += t1 - t0;

        if (!text) {
            fprintf(stderr, "Warning: could not read %s (skipped)\n", paths.items[idx]);
            continue;
        }

        Document *d = &docs[n];
        if (build_shingles(text, len, k, &d->shingles, &d->n_shingles, &d->n_tokens) != 0) {
            fprintf(stderr, "Out of memory while processing %s\n", paths.items[idx]);
            free(text);
            free_documents(docs, n);
            pathlist_free(&paths);
            return -1;
        }
        free(text);
        d->n_bytes = len;
        d->path = paths.items[idx];        /* ownership moves to the Document */
        paths.items[idx] = NULL;
        n++;
        stats->preprocess_seconds += omp_get_wtime() - t1;
    }
    pathlist_free(&paths);                 /* frees only the paths not moved */

    *out_docs = docs;
    *out_n = n;
    return 0;
}

void free_documents(Document *docs, int n)
{
    if (!docs) return;
    for (int i = 0; i < n; i++) {
        free(docs[i].path);
        free(docs[i].shingles);
    }
    free(docs);
}
