#ifndef SIMILARITY_H
#define SIMILARITY_H

#include <stddef.h>
#include "document.h"

/* One result: documents i and j (i < j) and their Jaccard similarity. */
typedef struct {
    int    i;
    int    j;
    double sim;
} SimPair;

/* Growable array of SimPair (owned by whoever holds the struct). */
typedef struct {
    SimPair *items;
    size_t   count;
    size_t   cap;
} PairList;

typedef struct {
    PairList pairs;          /* pairs with similarity >= threshold      */
    long long compared;      /* how many document pairs were compared   */
} CompareResult;

/* Number of elements common to two sorted, duplicate-free arrays. */
size_t intersection_size(const uint64_t *a, size_t na,
                         const uint64_t *b, size_t nb);

/* Jaccard = |A and B| / |A or B|. Returns 0.0 if both sets are empty. */
double jaccard(const Document *a, const Document *b);

/* Sequential baseline: plain loops, no OpenMP directives. */
void compare_sequential(const Document *docs, int n, double threshold,
                        CompareResult *res);

/* OpenMP version. The loop schedule is taken from the runtime setting
 * (call omp_set_schedule() before). Result pairs are in arbitrary order:
 * call sort_pairs() before comparing with another result. */
void compare_parallel(const Document *docs, int n, double threshold,
                      int threads, CompareResult *res);

/* Sort pairs by (i, j) so results from different runs can be compared. */
void sort_pairs(PairList *list);

void result_free(CompareResult *res);

#endif
