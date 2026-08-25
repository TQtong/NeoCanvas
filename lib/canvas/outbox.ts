'use client';

/**
 * 画布离线持久化 outbox。
 *
 * IndexedDB 只保存尚未被服务端确认的最后一条实体 mutation。复合主键保证同一项目实体天然
 * 合并，clientRevision 则阻止慢速旧写覆盖更晚的新写。删除时也会再次比较 revision，避免旧
 * 请求的成功响应误删正在等待提交的新版本。
 *
 * @module lib/canvas/outbox
 */

/** IndexedDB 数据库名。 */
export const CANVAS_OUTBOX_DATABASE = 'neocanvas-outbox';
/** mutation object store 名。 */
export const CANVAS_OUTBOX_STORE = 'mutations';
const DATABASE_VERSION = 1;

/** outbox 支持的实体。 */
export type OutboxEntity = 'node' | 'edge' | 'viewport';
/** outbox 操作。 */
export type OutboxOperation = 'upsert' | 'delete';

/** 单条未确认 mutation。 */
export interface OutboxEntry {
  projectId: string;
  entity: OutboxEntity;
  entityId: string;
  operation: OutboxOperation;
  payload: unknown;
  clientRevision: number;
  createdAt: string;
  updatedAt: string;
}

/** 浏览器不支持或禁止 IndexedDB 时抛出的明确错误。 */
export class OutboxUnavailableError extends Error {
  constructor(message = '当前浏览器无法使用离线保存存储') {
    super(message);
    this.name = 'OutboxUnavailableError';
  }
}

let databasePromise: Promise<IDBDatabase> | null = null;

/** 把 IDBRequest 转换为 Promise，并保留原始 DOMException。 */
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

/** 等待 transaction 完成，确保调用者拿到的是已经提交到磁盘的结果。 */
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务已中止'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'));
  });
}

/** 打开并按确定 schema 初始化 outbox。 */
export function openCanvasOutbox(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new OutboxUnavailableError());
  }

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(CANVAS_OUTBOX_DATABASE, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CANVAS_OUTBOX_STORE)) {
        const store = database.createObjectStore(CANVAS_OUTBOX_STORE, {
          keyPath: ['projectId', 'entity', 'entityId'],
        });
        store.createIndex('projectId', 'projectId', { unique: false });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(new OutboxUnavailableError(request.error?.message));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new OutboxUnavailableError('离线保存数据库升级被其他页面阻塞'));
    };
  });
  return databasePromise;
}

/** 写入 mutation；只有 revision 不旧于当前记录时才覆盖。 */
export async function putOutboxEntry(entry: OutboxEntry): Promise<void> {
  const database = await openCanvasOutbox();
  const transaction = database.transaction(CANVAS_OUTBOX_STORE, 'readwrite');
  const store = transaction.objectStore(CANVAS_OUTBOX_STORE);
  const key: [string, OutboxEntity, string] = [entry.projectId, entry.entity, entry.entityId];
  const current = (await requestResult(store.get(key))) as OutboxEntry | undefined;
  if (!current || current.clientRevision <= entry.clientRevision) store.put(entry);
  await transactionDone(transaction);
}

/** 删除已确认 mutation；同一实体已有更晚 revision 时保留更晚记录。 */
export async function deleteConfirmedOutboxEntry(
  projectId: string,
  entity: OutboxEntity,
  entityId: string,
  confirmedRevision: number,
): Promise<void> {
  const database = await openCanvasOutbox();
  const transaction = database.transaction(CANVAS_OUTBOX_STORE, 'readwrite');
  const store = transaction.objectStore(CANVAS_OUTBOX_STORE);
  const key: [string, OutboxEntity, string] = [projectId, entity, entityId];
  const current = (await requestResult(store.get(key))) as OutboxEntry | undefined;
  if (current && current.clientRevision <= confirmedRevision) store.delete(key);
  await transactionDone(transaction);
}

/** 读取一个项目全部未确认 mutation，按 revision 升序返回。 */
export async function listProjectOutbox(projectId: string): Promise<OutboxEntry[]> {
  const database = await openCanvasOutbox();
  const transaction = database.transaction(CANVAS_OUTBOX_STORE, 'readonly');
  const index = transaction.objectStore(CANVAS_OUTBOX_STORE).index('projectId');
  const entries = (await requestResult(index.getAll(IDBKeyRange.only(projectId)))) as OutboxEntry[];
  await transactionDone(transaction);
  return entries.sort((a, b) => a.clientRevision - b.clientRevision);
}

/** 返回项目待同步实体数。 */
export async function countProjectOutbox(projectId: string): Promise<number> {
  const database = await openCanvasOutbox();
  const transaction = database.transaction(CANVAS_OUTBOX_STORE, 'readonly');
  const index = transaction.objectStore(CANVAS_OUTBOX_STORE).index('projectId');
  const count = await requestResult(index.count(IDBKeyRange.only(projectId)));
  await transactionDone(transaction);
  return count;
}
