import {
  isSprintResult,
  normalizeSprintResult,
  type ResultPage,
  type ResultStore,
  type ResultStoreWriteResult,
  type SprintResult,
} from '../sprint/results'

const DATABASE_VERSION = 1
const RESULTS_STORE = 'results'
const BY_SESSION = 'bySession'
const BY_CONFIG_COMPLETED = 'byConfigCompleted'
const BY_CONFIG_RANK = 'byConfigRank'
const DEFAULT_DATABASE_NAME = 'mental-math-sprint-history'
export const DEFAULT_MAX_RESULTS_PER_CONFIG = 500
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
const MAX_RECENT_RESULTS = 500
export const MAX_CURSOR_SCAN_COUNT = 1_000
const MAX_PRUNE_PER_WRITE = 500

type StoredResult = {
  id: string
  sessionId: string
  configKey: string
  completedAt: number
  rankEligibleKey: number
  scoredElapsedMs: number
  mistakes: number
  result: SprintResult
}

class OpenError extends Error {
  readonly status: 'unavailable' | 'blocked'

  constructor(status: 'unavailable' | 'blocked') {
    super(status)
    this.status = status
  }
}

export class IndexedDbResultStore implements ResultStore {
  private databasePromise: Promise<IDBDatabase> | null = null
  private readonly factory: IDBFactory | null
  private readonly keyRange: typeof IDBKeyRange | null
  private readonly maxResultsPerConfig: number
  private readonly databaseName: string

  constructor(
    factory: IDBFactory | null = getIndexedDb(),
    keyRange: typeof IDBKeyRange | null = getKeyRange(),
    maxResultsPerConfig = DEFAULT_MAX_RESULTS_PER_CONFIG,
    databaseName = DEFAULT_DATABASE_NAME,
  ) {
    this.factory = factory
    this.keyRange = keyRange
    this.maxResultsPerConfig = maxResultsPerConfig
    this.databaseName = databaseName
  }

  async saveCompleted(result: SprintResult): Promise<ResultStoreWriteResult> {
    if (!isSprintResult(result) || result.completedAt < 0) return { status: 'failed' }
    try {
      const database = await this.open()
      return await new Promise((resolve) => {
        const transaction = database.transaction(RESULTS_STORE, 'readwrite')
        const store = transaction.objectStore(RESULTS_STORE)
        let status: ResultStoreWriteResult['status'] = 'failed'
        transaction.oncomplete = () => resolve({ status })
        transaction.onabort = () => resolve({ status: mapWriteError(transaction.error) })
        transaction.onerror = () => undefined

        const existingRequest = store.index(BY_SESSION).get(result.sessionId)
        existingRequest.onerror = () => transaction.abort()
        existingRequest.onsuccess = () => {
          if (existingRequest.result !== undefined) {
            status = 'duplicate'
            return
          }
          const range = this.configCompletedRange(result.configKey)
          const countRequest = store.index(BY_CONFIG_COMPLETED).count(range)
          countRequest.onerror = () => transaction.abort()
          countRequest.onsuccess = () => {
            const pruneCount = Math.min(MAX_PRUNE_PER_WRITE, Math.max(0, countRequest.result - this.maxResultsPerConfig + 1))
            if (pruneCount === 0) {
              addStoredResult(store, result, () => { status = 'saved' }, transaction)
              return
            }
            let removed = 0
            const cursorRequest = store.index(BY_CONFIG_COMPLETED).openCursor(range, 'next')
            cursorRequest.onerror = () => transaction.abort()
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result
              if (!cursor || removed >= pruneCount) {
                addStoredResult(store, result, () => { status = 'saved' }, transaction)
                return
              }
              const deleteRequest = cursor.delete()
              deleteRequest.onerror = () => transaction.abort()
              deleteRequest.onsuccess = () => {
                removed += 1
                cursor.continue()
              }
            }
          }
        }
      })
    } catch (error) {
      return { status: mapOpenError(error) }
    }
  }

  async getById(id: string): Promise<SprintResult | null> {
    try {
      const database = await this.open()
      return await new Promise((resolve) => {
        const request = database.transaction(RESULTS_STORE).objectStore(RESULTS_STORE).get(id)
        request.onerror = () => resolve(null)
        request.onsuccess = () => resolve(readStoredResult(request.result))
      })
    } catch {
      return null
    }
  }

  async listCompleted(configKey: string, cursor?: string, limit = DEFAULT_PAGE_SIZE): Promise<ResultPage> {
    const pageSize = normalizeLimit(limit)
    const decoded = cursor ? decodeCursor(cursor, configKey) : null
    if (cursor && !decoded) return failedPage()
    try {
      const database = await this.open()
      const lower: IDBValidKey = [configKey, 0, '']
      const upper: IDBValidKey = decoded?.key ?? [configKey, Number.MAX_SAFE_INTEGER, '\uffff']
      const range = this.requireKeyRange().bound(lower, upper, false, Boolean(decoded))
      return await this.collect(database, BY_CONFIG_COMPLETED, range, 'prev', pageSize, true, false)
    } catch (error) {
      return errorPage(error)
    }
  }

  async listRanked(configKey: string, limit = 5): Promise<ResultPage> {
    try {
      const range = this.requireKeyRange().bound(
        [configKey, 1, 0, 0, 0, ''],
        [configKey, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, '\uffff'],
      )
      return await this.collect(await this.open(), BY_CONFIG_RANK, range, 'next', normalizeLimit(limit), false, false)
    } catch (error) {
      return errorPage(error)
    }
  }

  async listCompletedSince(configKey: string, since: number): Promise<ResultPage> {
    if (!Number.isSafeInteger(since) || since < 0) return failedPage()
    try {
      const range = this.requireKeyRange().bound(
        [configKey, since, ''],
        [configKey, Number.MAX_SAFE_INTEGER, '\uffff'],
      )
      return await this.collect(await this.open(), BY_CONFIG_COMPLETED, range, 'next', MAX_RECENT_RESULTS, false, true)
    } catch (error) {
      return errorPage(error)
    }
  }

  async clearConfig(configKey: string): Promise<ResultStoreWriteResult> {
    try {
      const database = await this.open()
      return await new Promise((resolve) => {
        const transaction = database.transaction(RESULTS_STORE, 'readwrite')
        const request = transaction.objectStore(RESULTS_STORE).index(BY_CONFIG_COMPLETED)
          .openCursor(this.configCompletedRange(configKey))
        request.onerror = () => transaction.abort()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return
          cursor.delete()
          cursor.continue()
        }
        transaction.oncomplete = () => resolve({ status: 'cleared' })
        transaction.onabort = () => resolve({ status: mapWriteError(transaction.error) })
        transaction.onerror = () => undefined
      })
    } catch (error) {
      return { status: mapOpenError(error) }
    }
  }

  private async collect(
    database: IDBDatabase,
    indexName: string,
    range: IDBKeyRange,
    direction: IDBCursorDirection,
    limit: number,
    paginated: boolean,
    reportLimitAsTruncated: boolean,
  ): Promise<ResultPage> {
    return await new Promise((resolve) => {
      const transaction = database.transaction(RESULTS_STORE)
      const request = transaction.objectStore(RESULTS_STORE).index(indexName).openCursor(range, direction)
      const results: SprintResult[] = []
      let corruptRecords = 0
      let scannedRecords = 0
      let lastKey: IDBValidKey | null = null
      let hasMore = false
      request.onerror = () => resolve(failedPage())
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve({
            status: 'ok',
            results,
            nextCursor: paginated && hasMore && lastKey ? encodeCursor(lastKey) : null,
            corruptRecords,
            truncated: false,
          })
          return
        }
        scannedRecords += 1
        if (scannedRecords > MAX_CURSOR_SCAN_COUNT) {
          resolve({ status: 'ok', results, nextCursor: null, corruptRecords, truncated: true })
          return
        }
        const result = readStoredResult(cursor.value)
        if (!result) {
          corruptRecords += 1
          cursor.continue()
          return
        }
        if (results.length >= limit) {
          hasMore = true
          resolve({
            status: 'ok',
            results,
            nextCursor: paginated && lastKey ? encodeCursor(lastKey) : null,
            corruptRecords,
            truncated: reportLimitAsTruncated,
          })
          return
        }
        results.push(result)
        lastKey = cursor.key
        cursor.continue()
      }
    })
  }

  private configCompletedRange(configKey: string): IDBKeyRange {
    return this.requireKeyRange().bound(
      [configKey, 0, ''],
      [configKey, Number.MAX_SAFE_INTEGER, '\uffff'],
    )
  }

  private requireKeyRange(): typeof IDBKeyRange {
    if (!this.keyRange) throw new OpenError('unavailable')
    return this.keyRange
  }

  private open(): Promise<IDBDatabase> {
    if (!this.factory || !this.keyRange) return Promise.reject(new OpenError('unavailable'))
    if (this.databasePromise) return this.databasePromise
    const factory = this.factory
    const databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false
      const request = factory.open(this.databaseName, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        const store = database.objectStoreNames.contains(RESULTS_STORE)
          ? request.transaction!.objectStore(RESULTS_STORE)
          : database.createObjectStore(RESULTS_STORE, { keyPath: 'id' })
        if (!store.indexNames.contains(BY_SESSION)) store.createIndex(BY_SESSION, 'sessionId', { unique: true })
        if (!store.indexNames.contains(BY_CONFIG_COMPLETED)) {
          store.createIndex(BY_CONFIG_COMPLETED, ['configKey', 'completedAt', 'id'])
        }
        if (!store.indexNames.contains(BY_CONFIG_RANK)) {
          store.createIndex(BY_CONFIG_RANK, [
            'configKey', 'rankEligibleKey', 'scoredElapsedMs', 'mistakes', 'completedAt', 'id',
          ])
        }
      }
      request.onblocked = () => {
        if (!settled) {
          settled = true
          reject(new OpenError('blocked'))
        }
      }
      request.onerror = () => {
        if (!settled) {
          settled = true
          reject(new OpenError('unavailable'))
        }
      }
      request.onsuccess = () => {
        const database = request.result
        if (settled) {
          database.close()
          return
        }
        settled = true
        database.onversionchange = () => database.close()
        resolve(database)
      }
    }).catch((error) => {
      this.databasePromise = null
      throw error
    })
    this.databasePromise = databasePromise
    return databasePromise
  }
}

function addStoredResult(
  store: IDBObjectStore,
  result: SprintResult,
  onSaved: () => void,
  transaction: IDBTransaction,
): void {
  const request = store.add(toStoredResult(result))
  request.onerror = () => transaction.abort()
  request.onsuccess = onSaved
}

function toStoredResult(result: SprintResult): StoredResult {
  return {
    id: result.id,
    sessionId: result.sessionId,
    configKey: result.configKey,
    completedAt: result.completedAt,
    rankEligibleKey: result.rankEligible ? 1 : 0,
    scoredElapsedMs: result.totals.scoredElapsedMs,
    mistakes: result.totals.mistakes,
    result: structuredClone(result),
  }
}

function readStoredResult(value: unknown): SprintResult | null {
  try {
    if (typeof value !== 'object' || value === null) return null
    const stored = value as Partial<StoredResult>
    const rawResult = stored.result
    if (!isSprintResult(rawResult)) return null
    const result = normalizeSprintResult(rawResult)
    if (!result) return null
    if (
      stored.id !== result.id ||
      stored.sessionId !== result.sessionId ||
      stored.configKey !== result.configKey ||
      stored.completedAt !== result.completedAt ||
      stored.rankEligibleKey !== (result.rankEligible ? 1 : 0) ||
      stored.scoredElapsedMs !== result.totals.scoredElapsedMs ||
      stored.mistakes !== result.totals.mistakes
    ) return null
    return structuredClone(result)
  } catch {
    return null
  }
}

function normalizeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) return DEFAULT_PAGE_SIZE
  return Math.min(limit, MAX_PAGE_SIZE)
}

function encodeCursor(key: IDBValidKey): string {
  return encodeURIComponent(JSON.stringify({ version: 1, key }))
}

function decodeCursor(value: string, configKey: string): { key: IDBValidKey[] } | null {
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as { version?: unknown; key?: unknown }
    if (parsed.version !== 1 || !Array.isArray(parsed.key) || parsed.key[0] !== configKey) return null
    if (parsed.key.length !== 3 || !Number.isSafeInteger(parsed.key[1]) || typeof parsed.key[2] !== 'string') return null
    return { key: parsed.key as IDBValidKey[] }
  } catch {
    return null
  }
}

function failedPage(): ResultPage {
  return { status: 'failed', results: [], nextCursor: null, corruptRecords: 0, truncated: false }
}

function errorPage(error: unknown): ResultPage {
  const status = mapOpenError(error)
  return { status: status === 'blocked' ? 'blocked' : status === 'unavailable' ? 'unavailable' : 'failed', results: [], nextCursor: null, corruptRecords: 0, truncated: false }
}

function mapOpenError(error: unknown): ResultStoreWriteResult['status'] {
  return error instanceof OpenError ? error.status : 'failed'
}

function mapWriteError(error: DOMException | null): ResultStoreWriteResult['status'] {
  return error?.name === 'QuotaExceededError' ? 'quota-exceeded' : 'failed'
}

function getIndexedDb(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB
  } catch {
    return null
  }
}

function getKeyRange(): typeof IDBKeyRange | null {
  try {
    return typeof IDBKeyRange === 'undefined' ? null : IDBKeyRange
  } catch {
    return null
  }
}
