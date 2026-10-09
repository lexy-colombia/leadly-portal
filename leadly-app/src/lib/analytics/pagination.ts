/** Read every keyset page; never mistake the API row cap for the full dataset. */
export async function collectById<T extends { id: string }>(
  readPage: (after: string | null) => Promise<T[]>,
  pageSize = 500,
): Promise<T[]> {
  const result: T[] = []
  let after: string | null = null
  for (;;) {
    const rows = await readPage(after)
    result.push(...rows)
    if (rows.length < pageSize) return result
    const next = rows[rows.length - 1].id
    if (next === after) throw new Error('Pagination cursor did not advance')
    after = next
  }
}
