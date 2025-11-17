const META_DB_NAME = 'VideoEditorDB';
const META_DB_VERSION = 1;
const STORE_NAME = 'VideoRange';

async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(META_DB_NAME, META_DB_VERSION);
    // 首次创建或版本升级时触发
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      // 创建对象仓库，keyPath 定义了存储对象的唯一索引
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(`IndexedDB Error: ${request.error}`);
    };
  });
}

function wrapIDBRequest(request: IDBRequest): Promise<{ id: string, arrayBuffer: ArrayBuffer }> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function wrapIDBTransaction(transaction: IDBTransaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(undefined);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function readRange(id: string) {
  const db = await openDB();
  // 开启只读事务 (readonly)
  const transaction = db.transaction(STORE_NAME, 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  return wrapIDBRequest(store.get(id));
}

async function writeRange(data: any) {
  const db = await openDB();
  // 开启读写事务 (readwrite)
  const transaction = db.transaction(STORE_NAME, 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  await wrapIDBRequest(store.put(data));
  await wrapIDBTransaction(transaction);
}

export async function loadRange(url: string, start: number, end: number, options?: RequestInit) {
  const id = url + ':' + start + '-' + end;
  const cache = await readRange(id);
  if (cache) {
    return { status: 206, arrayBuffer: cache.arrayBuffer };
  }
  const response = await fetch(url, {
    ...options,
    cache: 'force-cache',
    headers: {
      'Cache-Control': 'max-age=31536000',
      Range: `bytes=${start}-${end}`,
    },
  });
  if (response.status === 206) {
    const arrayBuffer = await response.arrayBuffer();
    await writeRange({ id, arrayBuffer });
    return { status: 206, arrayBuffer };
  }
  return { status: response.status };
}
