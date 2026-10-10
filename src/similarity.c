#include "similarity.h"

#include <omp.h>
#include <stdio.h>
#include <stdlib.h>

/* ---------------- PairList helpers ---------------- */

static void pairlist_push(PairList *l, int i, int j, double sim)
{
    if (l->count == l->cap) {
        size_t new_cap = l->cap ? l->cap * 2 : 64;
        SimPair *tmp = realloc(l->items, new_cap * sizeof(SimPair));
        if (!tmp) {
            fprintf(stderr, "Out of memory while storing similar pairs\n");
            exit(EXIT_FAILURE);
        }
        l->items = tmp;
        l->cap = new_cap;
    }
    l->items[l->count].i = i;
    l->items[l->count].j = j;
    l->items[l->count].sim = sim;
    l->count++;
}

static int cmp_pair(const void *a, const void *b)
{
    const SimPair *x = a, *y = b;
    if (x->i != y->i) return (x->i > y->i) - (x->i < y->i);
    return (x->j > y->j) - (x->j < y->j);
}

void sort_pairs(PairList *list)
{
    if (list->count > 1) qsort(list->items, list->count, sizeof(SimPair), cmp_pair);
}

void result_free(CompareResult *res)
{
    free(res->pairs.items);
    res->pairs.items = NULL;
    res->pairs.count = res->pairs.cap = 0;
    res->compared = 0;
}

/* ---------------- Core similarity (shared by BOTH versions) ---------------- */

size_t intersection_size(const uint64_t *a, size_t na,
                         const uint64_t *b, size_t nb)
{
    size_t i = 0, j = 0, common = 0;
    while (i < na && j < nb) {
        if (a[i] < b[j])      i++;
        else if (a[i] > b[j]) j++;
        else { common++; i++; j++; }
    }
    return common;
}

double jaccard(const Document *a, const Document *b)
{
    size_t inter = intersection_size(a->shingles, a->n_shingles,
                                     b->shingles, b->n_shingles);
    size_t uni = a->n_shingles + b->n_shingles - inter;
    if (uni == 0) return 0.0;
    return (double)inter / (double)uni;
}

/* ---------------- Sequential version ---------------- */

void compare_sequential(const Document *docs, int n, double threshold,
                        CompareResult *res)
{
    res->pairs.items = NULL;
    res->pairs.count = res->pairs.cap = 0;
    res->compared = 0;

    for (int i = 0; i < n - 1; i++) {
        for (int j = i + 1; j < n; j++) {
            double s = jaccard(&docs[i], &docs[j]);
            res->compared++;
            if (s >= threshold) pairlist_push(&res->pairs, i, j, s);
        }
    }
    /* pairs are already in (i, j) order here */
}

/* ---------------- OpenMP version ----------------
 *
 * Parallel region : one team of `threads` threads is created ONCE.
 * Work-sharing    : the OUTER loop (over i) is divided among the threads.
 *                   Each (i, j) pair is handled by exactly one thread.
 * schedule(runtime): the schedule kind/chunk is chosen from main() with
 *                   omp_set_schedule() so we can compare static/dynamic/guided
 *                   without recompiling.
 *
 * SHARED  : docs, n, threshold, res (read-only inside the loop, except the
 *           final merge)
 * PRIVATE : j, s, `local` (each thread's own list of similar pairs), and each
 *           thread's own copy of `compared` (reduction)
 *
 * Synchronisation: none inside the loop. Each thread appends to its private
 * list. Only the final merge into res->pairs is protected by `critical`
 * (executed once per thread, not once per pair).
 */
void compare_parallel(const Document *docs, int n, double threshold,
                      int threads, CompareResult *res)
{
    res->pairs.items = NULL;
    res->pairs.count = res->pairs.cap = 0;
    res->compared = 0;

    long long compared = 0;

    #pragma omp parallel num_threads(threads) reduction(+:compared)
    {
        PairList local = {NULL, 0, 0};          /* private to this thread */

        #pragma omp for schedule(runtime) nowait
        for (int i = 0; i < n - 1; i++) {
            for (int j = i + 1; j < n; j++) {
                double s = jaccard(&docs[i], &docs[j]);
                compared++;
                if (s >= threshold) pairlist_push(&local, i, j, s);
            }
        }

        #pragma omp critical(merge_pairs)
        {
            for (size_t p = 0; p < local.count; p++)
                pairlist_push(&res->pairs, local.items[p].i,
                              local.items[p].j, local.items[p].sim);
        }
        free(local.items);
    }

    res->compared = compared;
    /* Pairs arrive in arbitrary thread order. The caller sorts them with
     * sort_pairs() AFTER timing, so sorting is not counted as compute time. */
}
