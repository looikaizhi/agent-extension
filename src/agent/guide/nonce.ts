/**
 * One nonce per snapshot instead of one per call.
 *
 * S-01 (design doc §8.1) wraps the element table in a tag carrying a nonce so
 * a page author cannot forge the closing tag and escape the wrapper. The
 * mechanism is that the nonce is generated *after* extraction, inside the
 * extension, from `crypto.randomUUID()` — a name written into the page before
 * that moment cannot match a value that did not exist yet. Nothing in that
 * argument depends on the nonce being different on the *next* call: the page
 * author still never sees it, because it never reaches the page. It travels
 * from here to the model endpoint and nowhere else.
 *
 * What a per-call nonce does cost is the prefix cache. Measured: 2560 of 2930
 * prompt tokens were cache hits, and the hit stopped exactly at the boundary
 * between the tool schema and the element table — because a fresh random
 * string sits immediately before the table, and a prefix cache matches bytes.
 * The table is the largest part of the prompt (~2300 tokens at 103 elements),
 * and 40% of consecutive calls send the same one.
 *
 * Deliberately not generated in the extractor: that runs in the content
 * script, one isolation boundary away from a hostile page. Keeping generation
 * in the panel keeps a security value out of the process nearest the attacker,
 * and costs only this small map.
 */

/** Keyed by `snapshotId`, which changes whenever the page is re-extracted. */
export interface NonceCache {
  (snapshotId: string, serialized: string): string;
}

/**
 * `max` bounds the map rather than tying it to a thread's life: a guide is a
 * handful of hops, and holding the last few snapshots covers every consecutive
 * call that could share one while keeping this from growing with the session.
 */
export function createNonceCache(newNonce: () => string = () => crypto.randomUUID(), max = 8): NonceCache {
  const seen = new Map<string, string>();

  return (snapshotId, serialized) => {
    const cached = seen.get(snapshotId);
    // Re-checked on reuse, not only on mint. The same `snapshotId` should mean
    // the same table, but this guard is the whole of S-01's edge case (04's
    // Gotchas) and it costs one `includes` — a table that somehow differs must
    // not be able to smuggle a matching literal past it.
    if (cached && !serialized.includes(cached)) return cached;

    let candidate = newNonce();
    while (serialized.includes(candidate)) candidate = newNonce();

    seen.set(snapshotId, candidate);
    // Oldest first: `Map` iterates in insertion order.
    if (seen.size > max) seen.delete(seen.keys().next().value as string);
    return candidate;
  };
}
