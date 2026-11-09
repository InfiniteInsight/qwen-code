export class Stream<T> implements AsyncIterable<T> {
  private returned: (() => void) | undefined;
  private queue: T[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  private isDone = false;
  hasError: Error | undefined;
  private started = false;

  constructor(returned?: () => void) {
    this.returned = returned;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.started) {
      throw new Error('Stream can only be iterated once');
    }
    this.started = true;
    return this;
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.queue.length > 0) {
      return Promise.resolve({
        done: false,
        value: this.queue.shift()!,
      });
    }
    if (this.hasError) {
      return Promise.reject(this.hasError);
    }
    if (this.isDone) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  enqueue(value: T): void {
    if (this.isDone || this.hasError) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
    } else {
      this.queue.push(value);
    }
  }

  done(): void {
    this.isDone = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.resolve({ done: true, value: undefined });
    }
  }

  error(error: Error): void {
    this.hasError = error;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(error);
    }
  }

  return(): Promise<IteratorResult<T>> {
    this.isDone = true;
    this.queue = [];
    // Settle any pending next() promises so awaiters don't hang forever.
    while (this.waiters.length > 0) {
      this.waiters.shift()!.resolve({ done: true, value: undefined });
    }
    if (this.returned) {
      this.returned();
    }
    return Promise.resolve({ done: true, value: undefined });
  }
}
