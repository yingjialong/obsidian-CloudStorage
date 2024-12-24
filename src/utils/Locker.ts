export class Lock {
    private _isLocked: boolean = false;
    private _waiting: (() => void)[] = [];

    async acquire(key: string = "count"): Promise<void> {
        while (this._isLocked) {
            await new Promise<void>(resolve => this._waiting.push(() => resolve()));
        }
        this._isLocked = true;
    }

    release(key: string = "count"): void {
        this._isLocked = false;
        if (this._waiting.length > 0) {
            const resolve = this._waiting.shift();
            if (resolve) {
                resolve();
            }
        }
    }
}
export class NonBlockingLock {
    private _lockMap: Map<string, boolean> = new Map();

    acquire(key: string = "default"): boolean {
        if (!this._lockMap.has(key)) {
            this._lockMap.set(key, false);
        }

        if (this._lockMap.get(key)) {
            return false;
        }

        this._lockMap.set(key, true);
        return true;
    }

    release(key: string = "default"): void {
        this._lockMap.set(key, false);
    }

    isLocked(key: string = "default"): boolean {
        return this._lockMap.get(key) ?? false;
    }
}
