export class InMemoryFirestore {
  private data = new Map<string, any>();
  // Serialize transactions to make concurrency deterministic in tests
  private txChain: Promise<void> = Promise.resolve();
  
  collection(collectionName: string) {
    return {
      doc: (docId: string) => {
        const fullPath = `${collectionName}/${docId}`;
        
        return {
            fullPath,
          get: async () => {
            const data = this.data.get(fullPath);
            return {
              exists: data !== undefined,
              data: () => data,
              id: docId
            };
          },
          set: async (data: any, options?: any) => {
            if (options?.merge === false && this.data.has(fullPath)) {
              throw new Error('Document already exists');
            }
            
            if (options?.merge) {
              const existing = this.data.get(fullPath) || {};
              this.data.set(fullPath, { ...existing, ...data });
            } else {
              this.data.set(fullPath, data);
            }
          },
          update: async (data: any) => {
            const existing = this.data.get(fullPath);
            if (!existing) {
              throw new Error('Document does not exist');
            }
            this.data.set(fullPath, { ...existing, ...data });
          },
          create: async (data: any) => {
            if (this.data.has(fullPath)) {
              throw new Error('Document already exists');
            }
            this.data.set(fullPath, data);
          },
          collection: (subCollection: string) => {
            return this.collection(`${fullPath}/${subCollection}`);
          }
        };
      },
      
      where: (field: string, op: string, value: any) => {
        return {
          get: async () => {
            const docs: any[] = [];
            
            for (const [path, data] of this.data.entries()) {
              if (path.startsWith(collectionName + '/')) {
                let matches = false;
                
                if (op === '==') {
                  matches = data[field] === value;
                } else if (op === 'in') {
                  matches = value.includes(data[field]);
                }
                
                if (matches) {
                  const docId = path.split('/').pop()!;
                  docs.push({
                    id: docId,
                    data: () => data,
                    exists: true
                  });
                }
              }
            }
            
            return {
              docs,
              empty: docs.length === 0,
              size: docs.length
            };
          }
        };
      },
      
      get: async () => {
        const docs: any[] = [];
        
        for (const [path, data] of this.data.entries()) {
          if (path.startsWith(collectionName + '/') && 
              path.split('/').length === 2) {
            const docId = path.split('/')[1];
            docs.push({
              id: docId,
              data: () => data,
              exists: true
            });
          }
        }
        
        return {
          docs,
          empty: docs.length === 0,
          size: docs.length
        };
      }
    };
  }
  
  runTransaction(callback: Function) {
    const execute = async () => {
      const writes: Array<{
        type: 'set' | 'create' | 'update';
        path: string;
        data: any;
        options?: any;
      }> = [];

      const alreadyExistsError = () => {
        const err = new Error('Document already exists');
        (err as any).code = 'already-exists';
        return err;
      };

      const transaction = {
        get: async (ref: any) => ref.get(),
        set: (ref: any, data: any, options?: any) => {
          writes.push({ type: 'set', path: ref.fullPath, data, options });
        },
        create: (ref: any, data: any) => {
          // Make create() conflict detectable *inside* the callback so user code can catch it.
          // This matches what our ingest code expects for the concurrent-start test.
          if (this.data.has(ref.fullPath)) {
            throw alreadyExistsError();
          }
          // Also protect against duplicate creates within the same transaction
          if (writes.some((w) => w.type === 'create' && w.path === ref.fullPath)) {
            throw alreadyExistsError();
          }
          writes.push({ type: 'create', path: ref.fullPath, data });
        },
        update: (ref: any, data: any) => {
          writes.push({ type: 'update', path: ref.fullPath, data });
        }
      };

      const result = await callback(transaction);

      // Apply all writes atomically
      for (const write of writes) {
        if (write.type === 'create') {
          if (this.data.has(write.path)) {
            // Should be rare due to eager check above, but keep it as a guard
            throw alreadyExistsError();
          }
          this.data.set(write.path, write.data);
        } else if (write.type === 'set') {
          if (write.options?.merge === false && this.data.has(write.path)) {
            throw alreadyExistsError();
          }
          if (write.options?.merge) {
            const existing = this.data.get(write.path) || {};
            this.data.set(write.path, { ...existing, ...write.data });
          } else {
            this.data.set(write.path, write.data);
          }
        } else if (write.type === 'update') {
          const existing = this.data.get(write.path);
          if (!existing) {
            throw new Error('Document does not exist');
          }
          this.data.set(write.path, { ...existing, ...write.data });
        }
      }

      return result;
    };

    // Serialize transactions to avoid racey interleavings in unit tests.
    // Ensure chain continues even if a transaction fails.
    const p = this.txChain.then(execute, execute);
    this.txChain = p.then(() => undefined, () => undefined);
    return p;
  }
  
  // Helper for tests
  getAllData() {
    return new Map(this.data);
  }
  
  clear() {
    this.data.clear();
  }
}